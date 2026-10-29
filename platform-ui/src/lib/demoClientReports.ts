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
// PV7-07 adds the monthly account summary (BFF §56): POST /clients/:clientId/reports/summary {period}, PATCH /client-reports/:id
// {narrativeMd}, and Publish for a summary (which renders its own file, so it needs none beforehand).
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
import { summaryPeriodLabel, validSummaryMonth, type NarrativeSource, type SummarySnapshot } from "./clientReports";

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
  /** An account summary only (BFF §56.3). */
  period?: string;
  narrativeMd?: string;
  narrativeSource?: NarrativeSource;
  generatedAt?: string;
  snapshot?: SummarySnapshot;
}
interface Store { reports: DemoReport[]; reads: Record<string, Record<string, string>> }

const daysAgo = (n: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString(); };

const PDF = "application/pdf";
const MD = "text/markdown";

const CLIENT_NAMES: Record<string, string> = { "cl-1": "Northwind Traders", "cl-2": "Cedar Group" };

/** A plausible month for the demo: two projects, what was completed, both turnaround sides, one results card, no money. */
export function demoSummarySnapshot(clientId: string, clientName: string, period: string): SummarySnapshot {
  const [y, mo] = period.split("-").map(Number);
  const first = `${period}-01`;
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const day = (n: number) => `${period}-${String(n).padStart(2, "0")}`;
  return {
    version: 1, clientId, clientName, period, periodStart: first, periodEnd: last, generatedAt: new Date().toISOString(),
    projects: [
      {
        projectId: "p-web-1", name: "Website relaunch", status: "active",
        milestones: { total: 6, done: 4, upcoming: 1, late: 1, undated: 0 }, deliverables: { total: 5, delivered: 3, late: 0 },
        nextMilestone: { name: "Launch review", dueDate: "2026-11-12" },
      },
      {
        projectId: "p-seo-1", name: "Search visibility", status: "active",
        milestones: { total: 3, done: 1, upcoming: 2, late: 0, undated: 0 }, deliverables: { total: 2, delivered: 1, late: 0 },
        nextMilestone: { name: "Keyword plan", dueDate: "2026-11-05" },
      },
    ],
    waiting: { onClient: { count: 2, oldestSince: `${day(12)}T08:00:00.000Z` }, onUs: { count: 1, oldestSince: `${day(20)}T08:00:00.000Z` } },
    completed: {
      milestones: {
        count: 2, knownSince: "2026-10-15", wholeMonthKnown: false,
        items: [
          { projectId: "p-web-1", projectName: "Website relaunch", name: "Design approved", completedOn: day(9) },
          { projectId: "p-seo-1", projectName: "Search visibility", name: "Audit delivered", completedOn: day(23) },
        ],
      },
      deliverables: {
        count: 1, basis: "status_changed_in_month",
        items: [{ projectId: "p-web-1", projectName: "Website relaunch", name: "Brand guide", status: "delivered", on: day(17) }],
      },
    },
    turnaround: {
      windowDays: 90, windowEnd: last,
      client: { medianDays: 2.5, n: 6, withheld: false },
      ours: { medianDays: 1, n: 2, withheld: true },
    },
    results: {
      generatedAt: new Date().toISOString(),
      services: [{
        service: "search", areaId: "search", title: "Search", status: "active", since: "2026-01-12",
        items: [{ label: "northwind.example", detail: null }],
        kpis: [
          { key: "search.organic_clicks", label: "Organic clicks", value: 4210, unit: "count", period: { from: first, to: last }, previous: 3890, target: null, asOf: last },
          { key: "search.avg_position", label: "Average position", value: 8.4, unit: "position", period: { from: first, to: last }, previous: 9.1, target: null, asOf: last },
        ],
        clientVisible: true,
      }],
      unavailable: [],
    },
    reports: [{ id: "rep-1", title: "Social media performance, September 2026", source: "social_report", periodStart: "2026-09-01", periodEnd: "2026-09-30", publishedOn: day(3) }],
    unavailable: [],
  };
}

/** The standard wording the backend writes when no AI text stands (a short paragraph built from the snapshot's own numbers). */
export function demoSummaryNarrative(s: SummarySnapshot): string {
  const label = summaryPeriodLabel(s.period);
  const ms = s.completed.milestones?.count ?? 0;
  const ds = s.completed.deliverables?.count ?? 0;
  const parts = [
    `In ${label}, ${ms} ${ms === 1 ? "milestone was" : "milestones were"} completed and ${ds} ${ds === 1 ? "deliverable was" : "deliverables were"} delivered across ${s.projects?.length ?? 0} projects.`,
  ];
  if (s.waiting) parts.push(`${s.waiting.onClient.count} items are waiting on you and ${s.waiting.onUs.count} on us.`);
  return parts.join("\n\n");
}

function summaryDraft(id: string, clientId: string, clientName: string, period: string, ageDays: number): DemoReport {
  const snapshot = demoSummarySnapshot(clientId, clientName, period);
  const [y, mo] = period.split("-").map(Number);
  return {
    id, clientId, clientName, projectId: null, portalProjectId: null, projectName: null,
    source: "account_summary", sourceId: null, deliverableId: null, title: `Account summary, ${summaryPeriodLabel(period)}`,
    periodStart: `${period}-01`, periodEnd: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10), status: "draft", file: null,
    createdAt: daysAgo(ageDays), publishedAt: null, publishedByName: null, withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    period, narrativeMd: demoSummaryNarrative(snapshot), narrativeSource: "deterministic", generatedAt: snapshot.generatedAt, snapshot,
  };
}

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
      source: "social_report", sourceId: "sr-demo-3", deliverableId: null, title: "Social media performance, October 2026 (draft)",
      periodStart: "2026-10-01", periodEnd: "2026-10-31", status: "draft",
      file: { id: "file-report-3", filename: "social-report-2026-10.pdf", contentType: PDF, byteSize: 96_330 },
      createdAt: daysAgo(2), publishedAt: null, publishedByName: null, withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    // A draft with NO file: Publish is refused with `report_has_no_file`.
    {
      id: "rep-7", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, portalProjectId: null, projectName: null,
      source: "search_report", sourceId: "sx-demo-3", deliverableId: null, title: "Search performance, October 2026 (file pending)",
      periodStart: "2026-10-01", periodEnd: "2026-10-31", status: "draft", file: null,
      createdAt: daysAgo(1), publishedAt: null, publishedByName: null, withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    // A drafted account summary (BFF §56): the frozen snapshot and an editable narrative; no file until Publish renders one.
    summaryDraft("rep-8", "cl-1", "Northwind Traders", "2026-09", 1),
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
/**
 * SCP-5a (BFF §63.18): sending a Social Media monthly report publishes its PDF into the client's reports (PV7-04a, `publishDeliveredReport`), where the client's contacts in reach read it.
 * Idempotent per source report (the server's own rule): a second publication of the same `sourceId` is the first one, `created: false`.
 */
export function demoPublishSocialReport(i: {
  sourceId: string; clientId: string; clientName: string; title: string; periodStart: string; periodEnd: string; filename: string;
}): { id: string; created: boolean } {
  const s = store();
  const prior = s.reports.find((r) => r.source === "social_report" && r.sourceId === i.sourceId && r.status === "published");
  if (prior) return { id: prior.id, created: false };
  const now = new Date().toISOString();
  const id = `rep-sr-${i.sourceId}`;
  s.reports.push({
    id, clientId: i.clientId, clientName: i.clientName, projectId: null, portalProjectId: null, projectName: null, source: "social_report", sourceId: i.sourceId, deliverableId: null,
    title: i.title, periodStart: i.periodStart, periodEnd: i.periodEnd, status: "published", file: { id: `file-${id}`, filename: i.filename, contentType: PDF, byteSize: 214_000 },
    createdAt: now, publishedAt: now, publishedByName: "Social Media team", withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
  });
  return { id, created: true };
}

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
  const { clientName: _c, portalProjectId: _p, period, narrativeMd, narrativeSource, generatedAt, snapshot, ...rest } = r;
  void _c; void _p;
  return {
    ...rest,
    // The summary fields belong to an account summary only; a social or search row keeps the PV7-04b shape exactly.
    ...(r.source === "account_summary" ? { period, narrativeMd, narrativeSource, generatedAt, snapshot } : {}),
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

  // PV7-07: draft an account summary. Order as the controller: read, the client (404), the draft action (403), THEN the body.
  if ((hit = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/reports\/summary$/)) && m === "POST") {
    if (!READ.has(userId)) return deny("read");
    const clientName = CLIENT_NAMES[hit[1]];
    if (!clientName) return err(404, "client not found");
    if (!WRITE.has(userId)) return deny("draft");
    let parsed: { period?: unknown } = {};
    try { parsed = body ? (JSON.parse(body) as { period?: unknown }) : {}; } catch { parsed = {}; }
    const period = typeof parsed.period === "string" ? parsed.period : "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return err(400, "invalid_period");
    if (!validSummaryMonth(period)) return err(400, "period_in_future");
    const live = s.reports.find((x) => x.clientId === hit![1] && x.source === "account_summary" && x.period === period && x.status !== "withdrawn");
    if (live) return live.status === "draft" ? ok({ created: false, report: staffView(live) }) : err(409, "summary_published");
    const made = summaryDraft(`rep-${s.reports.length + 100}`, hit[1], clientName, period, 0);
    s.reports.push(made);
    return ok({ created: true, report: staffView(made) });
  }

  // PV7-07: edit the draft's narrative.
  if ((hit = p.match(/^\/api\/[^/]+\/client-reports\/([^/]+)$/)) && m === "PATCH") {
    if (!READ.has(userId)) return deny("read");
    const r = s.reports.find((x) => x.id === hit![1]);
    if (!r) return err(404, "report not found");
    if (!WRITE.has(userId)) return deny("draft");
    if (r.source !== "account_summary") return err(409, "not_an_account_summary");
    if (r.status !== "draft") return err(409, "not_a_draft");
    let parsed: { narrativeMd?: unknown } = {};
    try { parsed = body ? (JSON.parse(body) as { narrativeMd?: unknown }) : {}; } catch { parsed = {}; }
    const text = typeof parsed.narrativeMd === "string" ? parsed.narrativeMd.trim() : "";
    if (!text) return err(400, "narrative_required");
    if (text.length > 20_000) return err(400, "narrative_too_long");
    r.narrativeMd = text;
    r.narrativeSource = "human";
    return ok({ report: staffView(r) });
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
      if (r.source === "account_summary") {
        // The backend renders the summary's PDF FIRST and stores it as the report's own file, then publishes (BFF §56.3).
        r.file = { id: `file-report-${r.id}`, filename: `account-summary-${r.period}.pdf`, contentType: PDF, byteSize: 88_240 };
      } else if (!r.file) return err(409, "report_has_no_file");
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

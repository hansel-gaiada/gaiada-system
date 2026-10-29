import "server-only";
// SCP-5a (BFF §63.18) — what DEMO_MODE answers for the Social Media monthly report, in the server's order of checks:
//
//   GET   reports?engagementId=&status=&period=       the list                                    POST  engagements/:engagementId/reports   draft a report (idempotent per client and month)
//   GET   reports/:id                                 the report and its document                 PATCH reports/:id                         notes, plan, narrative, submit and send back
//   POST  reports/:id/ai-draft                        a proposal; NOTHING is saved                POST  reports/:id/approve | deliver       the HoD check, and sending
//
// THE GATES (SCP-Q20, PERMISSION §53.7). Reading: any staff member (a client contact is refused). Writing (create, edit, submit, ai-draft): the two demo officers, the company admin and the
// four approvers. The HoD check (approve, and send back to draft) and sending (deliver): the four approvers only: the HoD and GM seats, the owner and the superadmin (`isDemoSocialApprover`);
// the officer and a company admin are refused. The report read says so in `canApprove` and `canDeliver`.
//
// THE ORDER OF CHECKS is the server's own (`social-reports.controller.ts`), route by route, which is not the same for every route:
//   create    ids and `kind` are checked first (400), then the role (403), then a replayed id or the month's existing report (the same report, `draftedVia: 'existing'`), then the client (404);
//   list      the role (403), then the filters (400 `invalid_field` + `field`);
//   read      the report (404), then the role (403);
//   patch     the report (404), then the role (403: `approve` to send back, `update` to edit), then the body (400 `invalid_field` + `field`), then the move (400 `cannot_submit_from_this_status`,
//             `cannot_send_back_from_this_status`, `invalid_status_transition`, `report_not_editable`);
//   ai-draft  the report (404), the role (403), then `report_not_editable` (400);   approve  the report (404), the role (403), `cannot_approve_from_this_status`, then `notes_incomplete`;
//   deliver   the report (404), the role (403), `cannot_deliver_from_this_status`, then the publication.
// Every 400 here is the module's `refuse()`: `{ error: "<code>" }`. Sending PUBLISHES into the client reports twin (`demoClientReports.ts`, PV7-04a), where the client's contacts read it.
//
// THE DATA is invented: Northwind Traders' report for last month is Ready to send; Harborlight Hotel's is in the HoD check and SIMULATED (its numbers came from the simulator, whose accounts
// the demo runs); Saltmarsh Day Spa has none yet (its report is due); Northwind's report for this month is a draft with one area still missing. "Draft with AI" answers `ai` for a client
// whose numbers are real and `template` for the simulated one (as if the gateway were down), so both sentences of the page can be seen.
import { demoMonthShift, DEMO_SOCIAL_DEPT, PIPE_ENGAGEMENTS, PIPE_POSTS, SEAT_APPROVERS, allocStore, isClientContact, isDemoSocialApprover, setDemoReportNeedsReader, type DemoResult } from "./demoSocialPipeline";
import { demoPublishSocialReport } from "./demoClientReports";
import { todayIsoInDisplayZone } from "./format";
import { isIsoDate } from "./contracts";
import { monthTitle } from "./socialClient";
import {
  ACTION_MAX, ACTION_OWNERS, ACTION_PLAN_MAX, AREA_LABEL, NOTE_AREAS, NOTE_MAX, isEditableState, notesAreComplete, type ReportAction, type ReportNotes,
} from "./socialReports";
import type { ReportDocument, ReportKpi, ReportSeries, ReportTable } from "./reports";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ID = /^[\w-]{1,64}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = ["draft", "in_review", "approved", "delivered"];
const KINDS = ["monthly", "campaign", "adhoc"];
/** The demo's staff who write reports: the two officers and the company admin. The four approvers write too. */
const WRITERS = new Set(["u-social", "u-social-2", "u-dev"]);
/** The Social Media head and GM seats: the holders of the Needs-you items "to check" and "to send" (the owner and the superadmin act from the same pages and get no queue). */
const QUEUE_SEATS = SEAT_APPROVERS.filter((u) => u !== "demo-hansel");
const denied = (action: string): DemoResult => err(403, `not authorized: cerbos denied ${action} on social_report`);

// ── the store ────────────────────────────────────────────────────────────────────────────────

export interface ReportRec {
  id: string;
  engagementId: string;
  period: string | null;
  kind: string;
  status: string;
  createdAt: string;
  /** The last time the report changed (a save, a move, the check, sending): what the Team dashboard reads as "since". */
  updatedAt: string;
  approvedAt: string | null;
  deliveredAt: string | null;
  narrativeMd: string;
  narrativeSource: "ai" | "deterministic";
  notes: ReportNotes;
  actionPlan: ReportAction[];
  simulated: boolean;
  /** The frozen numbers: taken when the report is created, never recomputed. */
  kpis: ReportKpi[];
  series: ReportSeries[];
  tables: ReportTable[];
  clientReportId: string | null;
  filename: string | null;
}
export interface ReportStore { reports: ReportRec[]; seq: number }

export const emptyReportStore = (): ReportStore => ({ reports: [], seq: 0 });

const iso = (ms: number): string => new Date(ms).toISOString();
const hoursAgo = (h: number): string => iso(Date.now() - h * 3_600_000);
const engagementOf = (id: string) => PIPE_ENGAGEMENTS.find((e) => e.id === id && e.status !== "closed");
const officerOf = (engagementId: string): string | null => allocStore.byEngagement[engagementId]?.officerId ?? null;
/** The client whose numbers came from the simulator: the demo's accounts are simulated, so a client with a simulated post has simulated numbers. */
const isSimulatedClient = (engagementId: string): boolean => PIPE_POSTS.some((p) => p.engagementId === engagementId && p.simulated);

/** A small deterministic number from a text, so a report's numbers are the same on every read and every run. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const monthEnd = (period: string): string => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** The month's frozen numbers for one client: followers, reach, impressions, engagements and the rate; a daily followers line; the best posts; Northwind's boosts as its own ad spend. */
function snapshotFor(engagementId: string, period: string | null): Pick<ReportRec, "kpis" | "series" | "tables"> {
  const seed = hash(`${engagementId}:${period ?? ""}`);
  const base = 1800 + (seed % 4000);
  const growth = 40 + (seed % 160);
  const reach = 9000 + (seed % 21000);
  const impressions = Math.round(reach * 1.6);
  const engagements = Math.round(reach * (0.03 + (seed % 40) / 1000));
  const rate = Math.round((engagements / reach) * 1000) / 10;
  const kpi = (metricKey: string, label: string, value: number, unit: ReportKpi["unit"]): ReportKpi => ({ metricKey, label, unit, value, appraisalSafe: false });
  const days = period && PERIOD.test(period) ? Number(monthEnd(period).slice(8, 10)) : 30;
  const start = period && PERIOD.test(period) ? `${period}-01` : todayIsoInDisplayZone().slice(0, 7) + "-01";
  const points = Array.from({ length: days }, (_, i) => ({ t: `${start.slice(0, 8)}${String(i + 1).padStart(2, "0")}`, v: base + Math.round((growth * i) / Math.max(1, days - 1)) }));
  const tables: ReportTable[] = [{
    key: "top_posts", label: "Top posts",
    columns: [{ key: "network", label: "Network" }, { key: "publishedAt", label: "Published" }, { key: "impressions", label: "Impressions", unit: "count", align: "right" }, { key: "likes", label: "Likes", unit: "count", align: "right" }],
    rows: [0, 1, 2].map((i) => ({ network: ["Instagram", "Facebook", "TikTok"][i], publishedAt: `${start.slice(0, 8)}${String(4 + i * 7).padStart(2, "0")}`, impressions: Math.round(impressions / (3 + i)), likes: Math.round(engagements / (4 + i)) })),
  }];
  if (engagementOf(engagementId)?.clientId === "cl-1") {
    tables.push({
      key: "ad_spend", label: "Paid boosts (your own ad spend)",
      columns: [{ key: "post", label: "Post" }, { key: "spend", label: "Spend", align: "right" }, { key: "currency", label: "Currency" }],
      rows: [{ post: "Harvest collection arrives", spend: 450000, currency: "IDR" }], totalRow: { post: "Total", spend: 450000, currency: "IDR" },
    });
  }
  return {
    kpis: [kpi("followers_total", "Followers", base + growth, "count"), kpi("reach_month", "Reach", reach, "count"), kpi("impressions_month", "Impressions", impressions, "count"),
      kpi("engagements_month", "Engagements", engagements, "count"), kpi("engagement_rate", "Engagement rate", rate, "percent")],
    series: [{ key: "followers", label: "Followers", unit: "count", kind: "line", points }],
    tables,
  };
}

const kpiValue = (r: ReportRec, label: string): number | null => r.kpis.find((k) => k.label === label)?.value ?? null;

/** The plain template, from the month's own numbers only (the server's `templateNotes` and `templateActionPlan`). */
function templateDraft(r: ReportRec): { narrativeMd: string; notes: Required<ReportNotes>; actionPlan: ReportAction[] } {
  const label = r.period ? monthTitle(r.period) : "the period";
  const followers = kpiValue(r, "Followers");
  const rate = kpiValue(r, "Engagement rate");
  const reach = kpiValue(r, "Reach");
  return {
    narrativeMd: `Performance summary for ${label}. Followers stood at ${followers} at the end of the month; posts reached ${reach} accounts and the engagement rate was ${rate}%.`,
    notes: {
      followers: { insight: `Followers stood at ${followers} at the end of ${label}.`, suggestion: "Keep to the agreed posting schedule and note which formats bring in new followers." },
      engagement: { insight: `The engagement rate was ${rate}% for ${label}.`, suggestion: "Repeat the formats and topics of the best-performing posts, and answer comments promptly." },
      audience: { insight: `Posts reached ${reach} accounts in ${label}.`, suggestion: "Review the posting times against when the audience is most active." },
    },
    actionPlan: [
      { action: "Review the month's best-performing posts and plan more in the same formats.", owner: "agency" },
      { action: "Confirm next month's priorities, promotions and key dates.", owner: "client" },
    ],
  };
}

/** "Draft with AI" for a client whose numbers are real: the same facts, in the brand's voice (the demo's twin of the model's answer). */
function aiDraft(r: ReportRec, clientName: string): { narrativeMd: string; notes: Required<ReportNotes>; actionPlan: ReportAction[] } {
  const t = templateDraft(r);
  const label = r.period ? monthTitle(r.period) : "the period";
  return {
    narrativeMd: `${clientName} had a steady ${label}. Followers reached ${kpiValue(r, "Followers")}, and the engagement rate of ${kpiValue(r, "Engagement rate")}% shows the audience is responding to the warm, direct posts the brand is known for.`,
    notes: {
      followers: { insight: `${t.notes.followers.insight} The growth was steady across the month, with no single spike.`, suggestion: "Lean on the posts that earned follows: show the people and the place behind the brand." },
      engagement: { insight: `${t.notes.engagement.insight} Reels and carousels drew the most replies.`, suggestion: "Plan two more reels next month and ask a question in each caption to start a conversation." },
      audience: { insight: `${t.notes.audience.insight} Most of it came on weekday evenings.`, suggestion: "Move one weekly post to the evening slot and compare reach next month." },
    },
    actionPlan: [
      { action: "Plan two more reels for next month, each ending with a question.", owner: "agency" },
      { action: "Send the dates of next month's promotions and events.", owner: "client" },
      { action: "Move one weekly post to the evening slot and compare reach.", owner: "agency" },
    ],
  };
}

/** The demo's invented reports (see the file header), built from the demo pipeline's own clients and the day the store is first touched. */
export function seedReportStore(): ReportStore {
  const s = emptyReportStore();
  const M = todayIsoInDisplayZone().slice(0, 7);
  const last = demoMonthShift(M, -1);
  const [north, , hotel] = PIPE_ENGAGEMENTS;
  const add = (engagementId: string, period: string, o: Partial<ReportRec> & { status: string }): ReportRec => {
    const snap = snapshotFor(engagementId, period);
    const rec: ReportRec = {
      id: `soc-rep-${++s.seq}`, engagementId, period, kind: "monthly", createdAt: hoursAgo(72), updatedAt: hoursAgo(72), approvedAt: null, deliveredAt: null, narrativeMd: "", narrativeSource: "deterministic",
      notes: {}, actionPlan: [], simulated: isSimulatedClient(engagementId), clientReportId: null, filename: null, ...snap, ...o,
    };
    const t = templateDraft(rec);
    if (!rec.narrativeMd) rec.narrativeMd = t.narrativeMd;
    if (o.updatedAt === undefined) rec.updatedAt = o.approvedAt ?? o.deliveredAt ?? rec.createdAt;
    s.reports.push(rec);
    return rec;
  };
  const full = (r: Pick<ReportRec, "kpis">): { notes: Required<ReportNotes>; actionPlan: ReportAction[] } => {
    const t = templateDraft(r as ReportRec);
    return { notes: t.notes, actionPlan: t.actionPlan };
  };
  if (north) {
    // Northwind: two months back is long sent; last month is Ready to send (the HoD approved it yesterday); this month's is a draft with the audience area still to write.
    add(north.id, demoMonthShift(M, -2), { status: "delivered", createdAt: hoursAgo(24 * 40), approvedAt: hoursAgo(24 * 36), deliveredAt: hoursAgo(24 * 35), filename: `social-report-${demoMonthShift(M, -2)}-a1b2c3d4.pdf`, ...full({ kpis: snapshotFor(north.id, demoMonthShift(M, -2)).kpis }) });
    add(north.id, last, { status: "approved", approvedAt: hoursAgo(20), createdAt: hoursAgo(96), ...full({ kpis: snapshotFor(north.id, last).kpis }) });
    const partial = full({ kpis: snapshotFor(north.id, M).kpis });
    add(north.id, M, { status: "draft", createdAt: hoursAgo(6), notes: { followers: partial.notes.followers, engagement: partial.notes.engagement }, actionPlan: partial.actionPlan.slice(0, 1) });
  }
  if (hotel) {
    // Harborlight: last month is in the HoD check, with every area written; its numbers are the simulator's.
    add(hotel.id, last, { status: "in_review", createdAt: hoursAgo(48), ...full({ kpis: snapshotFor(hotel.id, last).kpis }) });
  }
  return s;
}

// ── the document ─────────────────────────────────────────────────────────────────────────────

const AREA_TABLE_LABEL: Record<(typeof NOTE_AREAS)[number], string> = AREA_LABEL;

function documentOf(r: ReportRec, clientName: string): ReportDocument {
  const start = r.period && PERIOD.test(r.period) ? `${r.period}-01` : todayIsoInDisplayZone().slice(0, 7) + "-01";
  const end = r.period && PERIOD.test(r.period) ? monthEnd(r.period) : start;
  const tables: ReportTable[] = [...r.tables];
  const noteRows = NOTE_AREAS.flatMap((a) => {
    const n = r.notes[a];
    return n && (/\S/.test(n.insight) || /\S/.test(n.suggestion)) ? [{ area: AREA_TABLE_LABEL[a], insight: n.insight, suggestion: n.suggestion }] : [];
  });
  if (noteRows.length > 0) {
    tables.push({ key: "notes", label: "Insights and suggestions", columns: [{ key: "area", label: "Area" }, { key: "insight", label: "Insight" }, { key: "suggestion", label: "Suggestion" }], rows: noteRows });
  }
  if (r.actionPlan.length > 0) {
    tables.push({
      key: "action_plan", label: "Action plan", columns: [{ key: "action", label: "Action" }, { key: "owner", label: "Owner" }, { key: "due", label: "Due" }],
      rows: r.actionPlan.map((x) => ({ action: x.action, owner: x.owner === "client" ? "Client" : "Agency", due: x.due ?? null })),
    });
  }
  return {
    header: {
      tenantId: "co-agency", grain: "company", scopeRef: r.engagementId, scopeName: clientName, periodKind: "month", periodStart: start, periodEnd: end,
      dayCount: Number(end.slice(8, 10)) - Number(start.slice(8, 10)) + 1, periodLabel: r.period ? monthTitle(r.period) : "Custom period", generatedAt: new Date().toISOString(), sealed: false,
    },
    kpis: r.kpis, series: r.series, distributions: [], tables, highlights: [],
    narrative: { source: r.narrativeSource, text: r.narrativeMd },
    ...(r.simulated ? { simulated: true } : {}),
  };
}

// ── the server's validation, twinned (`report-notes.ts`) ─────────────────────────────────────────

function validateNotes(v: unknown): ReportNotes | null {
  if (!isObj(v)) return null;
  const out: ReportNotes = {};
  for (const [key, area] of Object.entries(v)) {
    if (!(NOTE_AREAS as readonly string[]).includes(key) || !isObj(area)) return null;
    for (const k of Object.keys(area)) if (k !== "insight" && k !== "suggestion") return null;
    const insight = area.insight === undefined ? "" : area.insight;
    const suggestion = area.suggestion === undefined ? "" : area.suggestion;
    if (typeof insight !== "string" || typeof suggestion !== "string" || insight.length > NOTE_MAX || suggestion.length > NOTE_MAX) return null;
    out[key as (typeof NOTE_AREAS)[number]] = { insight, suggestion };
  }
  return out;
}
function validateActionPlan(v: unknown): ReportAction[] | null {
  if (!Array.isArray(v) || v.length > ACTION_PLAN_MAX) return null;
  const out: ReportAction[] = [];
  for (const item of v) {
    if (!isObj(item)) return null;
    for (const k of Object.keys(item)) if (k !== "action" && k !== "owner" && k !== "due") return null;
    const { action, owner, due } = item;
    if (typeof action !== "string" || !/\S/.test(action) || action.length > ACTION_MAX) return null;
    if (typeof owner !== "string" || !(ACTION_OWNERS as readonly string[]).includes(owner)) return null;
    if (due !== undefined && due !== null && (typeof due !== "string" || !isIsoDate(due))) return null;
    out.push({ action, owner: owner as ReportAction["owner"], ...(typeof due === "string" ? { due } : {}) });
  }
  return out;
}

// ── the routes ───────────────────────────────────────────────────────────────────────────────

export function reportApi(store: ReportStore) {
  const find = (id: string): ReportRec | undefined => store.reports.find((r) => r.id === id);
  const nameOf = (r: ReportRec): string => engagementOf(r.engagementId)?.clientName ?? PIPE_ENGAGEMENTS.find((e) => e.id === r.engagementId)?.clientName ?? "A client";
  const canRead = (userId: string): boolean => !isClientContact(userId);
  const canWrite = (userId: string): boolean => canRead(userId) && (WRITERS.has(userId) || isDemoSocialApprover(userId));
  const complete = (r: ReportRec): boolean => r.kind !== "monthly" || notesAreComplete(r.notes);

  const row = (r: ReportRec) => ({
    id: r.id, engagementId: r.engagementId, clientName: nameOf(r), period: r.period, kind: r.kind, status: r.status, createdAt: r.createdAt, approvedAt: r.approvedAt, deliveredAt: r.deliveredAt,
    notesComplete: complete(r), simulated: r.simulated,
  });
  const existing = (r: ReportRec) => ({
    id: r.id, status: r.status, metrics: { kpis: r.kpis, series: r.series, tables: r.tables }, narrativeMd: r.narrativeMd, notes: r.notes, actionPlan: r.actionPlan, simulated: r.simulated, draftedVia: "existing",
  });

  function create(engagementId: string, body: string | undefined, userId: string): DemoResult {
    let b: Record<string, unknown>;
    try { b = body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { b = {}; }
    if (!ID.test(engagementId)) return err(400, "engagement_id_invalid");
    if (b.id !== undefined && b.id !== null && b.id !== "" && (typeof b.id !== "string" || !ID.test(b.id))) return err(400, "id_invalid");
    const kind = typeof b.kind === "string" ? b.kind : "monthly";
    if (!KINDS.includes(kind)) return err(400, "invalid_kind");
    if (!canWrite(userId)) return denied("create");
    const id = typeof b.id === "string" && b.id !== "" ? b.id : `soc-rep-${store.seq + 1}`;
    const same = find(id);
    if (same && same.engagementId === engagementId) return ok(existing(same), 201);
    const e = engagementOf(engagementId);
    if (!e) return err(404, "engagement not found");
    const period = typeof b.period === "string" ? b.period : null;
    const prior = kind === "monthly" && period !== null ? store.reports.find((r) => r.engagementId === engagementId && r.kind === "monthly" && r.period === period) : undefined;
    if (prior) return ok(existing(prior), 201);
    store.seq += 1;
    const snap = snapshotFor(engagementId, period);
    const rec: ReportRec = {
      id, engagementId, period, kind, status: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), approvedAt: null, deliveredAt: null, narrativeMd: "", narrativeSource: "deterministic",
      notes: {}, actionPlan: [], simulated: isSimulatedClient(engagementId), clientReportId: null, filename: null, ...snap,
    };
    // The month's report is drafted with its notes and plan, by the model when the gateway answers and by the plain template when it does not.
    const via = rec.simulated ? "fallback" : "ai";
    const draft = via === "ai" ? aiDraft(rec, e.clientName) : templateDraft(rec);
    rec.narrativeMd = draft.narrativeMd;
    rec.narrativeSource = via === "ai" ? "ai" : "deterministic";
    if (kind === "monthly") { rec.notes = draft.notes; rec.actionPlan = draft.actionPlan; }
    store.reports.push(rec);
    return ok({ id, status: "draft", metrics: { kpis: rec.kpis, series: rec.series, tables: rec.tables }, narrativeMd: rec.narrativeMd, notes: rec.notes, actionPlan: rec.actionPlan, simulated: rec.simulated, draftedVia: via, groundedOn: [] }, 201);
  }

  function list(params: URLSearchParams, userId: string): DemoResult {
    if (!canRead(userId)) return denied("read");
    const engagementId = params.get("engagementId");
    const status = params.get("status");
    const period = params.get("period");
    if (engagementId !== null && !ID.test(engagementId)) return err(400, "invalid_field", { field: "engagementId" });
    if (status !== null && !STATUSES.includes(status)) return err(400, "invalid_field", { field: "status" });
    if (period !== null && !PERIOD.test(period)) return err(400, "invalid_field", { field: "period" });
    const rows = store.reports
      .filter((r) => (!engagementId || r.engagementId === engagementId) && (!status || r.status === status) && (!period || r.period === period))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return ok({ reports: rows.map(row) });
  }

  function read(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    if (!canRead(userId)) return denied("read");
    return ok({
      id: r.id, status: r.status, engagementId: r.engagementId, kind: r.kind, period: r.period, notes: r.notes, actionPlan: r.actionPlan, simulated: r.simulated,
      notesComplete: complete(r), canApprove: isDemoSocialApprover(userId), canDeliver: isDemoSocialApprover(userId), document: documentOf(r, nameOf(r)),
    });
  }

  function patch(id: string, body: string | undefined, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    let b: Record<string, unknown>;
    try { b = body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { b = {}; }
    const sendingBack = b.status === "draft";
    const editing = b.narrativeMd !== undefined || b.notes !== undefined || b.actionPlan !== undefined;
    if (sendingBack) {
      if (!isDemoSocialApprover(userId)) return denied("approve");
      if (editing && !canWrite(userId)) return denied("update");
    } else if (!canWrite(userId)) return denied("update");

    if (b.narrativeMd !== undefined && typeof b.narrativeMd !== "string") return err(400, "invalid_field", { field: "narrativeMd" });
    let notes: ReportNotes | undefined;
    if (b.notes !== undefined) {
      const v = validateNotes(b.notes);
      if (!v) return err(400, "invalid_field", { field: "notes" });
      notes = v;
    }
    let plan: ReportAction[] | undefined;
    if (b.actionPlan !== undefined) {
      const v = validateActionPlan(b.actionPlan);
      if (!v) return err(400, "invalid_field", { field: "actionPlan" });
      plan = v;
    }

    let target = r.status;
    if (b.status !== undefined) {
      if (b.status === "in_review") {
        if (r.status !== "draft") return err(400, "cannot_submit_from_this_status");
        target = "in_review";
      } else if (b.status === "draft") {
        if (r.status !== "in_review") return err(400, "cannot_send_back_from_this_status");
        target = "draft";
      } else return err(400, "invalid_status_transition");
    } else if (!isEditableState(r.status)) return err(400, "report_not_editable");

    if (typeof b.narrativeMd === "string") { r.narrativeMd = b.narrativeMd; r.narrativeSource = "deterministic"; }
    if (notes) r.notes = notes;
    if (plan) r.actionPlan = plan;
    r.status = target;
    r.updatedAt = new Date().toISOString();
    return ok({ id, status: target });
  }

  function aiDraftRoute(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    if (!canWrite(userId)) return denied("update");
    if (!isEditableState(r.status)) return err(400, "report_not_editable");
    // A proposal only: the store is not touched.
    const simulated = r.simulated;
    const draft = simulated ? templateDraft(r) : aiDraft(r, nameOf(r));
    return ok({ narrativeMd: draft.narrativeMd, notes: draft.notes, actionPlan: draft.actionPlan, draftedVia: simulated ? "template" : "ai" });
  }

  function approve(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    if (!isDemoSocialApprover(userId)) return denied("approve");
    if (r.status !== "in_review") return err(400, "cannot_approve_from_this_status");
    if (!complete(r)) return err(400, "notes_incomplete");
    r.status = "approved";
    r.approvedAt = new Date().toISOString();
    r.updatedAt = r.approvedAt;
    return ok({ id, status: "approved" });
  }

  function deliver(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    if (!isDemoSocialApprover(userId)) return denied("deliver");
    if (r.status !== "approved") return err(400, "cannot_deliver_from_this_status");
    const e = engagementOf(r.engagementId);
    const filename = `social-report-${r.period ?? r.kind}-${r.id.slice(-8)}.pdf`;
    const when = new Date().toISOString();
    // PV7-04a: the PDF is published to the client's portal reports (`demoClientReports.ts`), in the title and period the server writes.
    const published = demoPublishSocialReport({
      sourceId: r.id, clientId: e?.clientId ?? "cl-1", clientName: nameOf(r), title: r.period ? `Social media performance, ${monthTitle(r.period)}` : "Social media performance",
      periodStart: r.period && PERIOD.test(r.period) ? `${r.period}-01` : when.slice(0, 10), periodEnd: r.period && PERIOD.test(r.period) ? monthEnd(r.period) : when.slice(0, 10), filename,
    });
    r.status = "delivered";
    r.deliveredAt = when;
    r.updatedAt = when;
    r.filename = filename;
    r.clientReportId = published.id;
    return ok({ id, status: "delivered", fileId: `soc-file-${r.id}`, filename, deliverableId: null, clientReportId: published.id });
  }

  /** The Needs-you items of the monthly reports (BFF §63.7, §63.18): due for the officer of each client, to check and to send for the HoD and GM seats. */
  function needsYou(tenantId: string, userId: string): Array<Record<string, unknown>> {
    const today = todayIsoInDisplayZone();
    const month = today.slice(0, 7);
    const period = demoMonthShift(month, -1);
    const base = `/departments/${DEMO_SOCIAL_DEPT}/social-reports`;
    const items: Array<Record<string, unknown>> = [];
    for (const e of PIPE_ENGAGEMENTS) {
      const day = allocStore.byEngagement[e.id]?.reportDueDay ?? null;
      if (officerOf(e.id) !== userId || day === null || e.status === "closed") continue;
      const mine = store.reports.find((r) => r.engagementId === e.id && r.kind === "monthly" && r.period === period);
      if (mine?.status === "delivered") continue;
      const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
      items.push({
        id: `social:${tenantId}:${mine?.id ?? e.id}:report_due`, kind: "report_due", role: "officer", title: `Monthly report, ${monthTitle(period)}`, clientName: e.clientName,
        since: `${month}-01T00:00:00.000Z`, due: `${month}-${String(Math.min(day, last)).padStart(2, "0")}`, href: mine ? `${base}/${mine.id}` : base,
      });
    }
    if (QUEUE_SEATS.includes(userId)) {
      for (const r of store.reports) {
        if (r.status !== "in_review" && r.status !== "approved") continue;
        const e = PIPE_ENGAGEMENTS.find((x) => x.id === r.engagementId);
        const check = r.status === "in_review";
        const day = allocStore.byEngagement[r.engagementId]?.reportDueDay ?? null;
        const due = r.kind === "monthly" && r.period && day !== null ? `${demoMonthShift(r.period, 1)}-${String(Math.min(day, 28)).padStart(2, "0")}` : null;
        items.push({
          id: `social:${tenantId}:${r.id}:${check ? "report_check" : "report_send"}`, kind: check ? "report_check" : "report_send", role: "approver",
          title: r.period ? `Monthly report, ${monthTitle(r.period)}` : "Report", clientName: e?.clientName ?? "A client", since: check ? r.createdAt : r.approvedAt ?? r.createdAt,
          ...(due ? { due } : {}), href: `${base}/${r.id}`,
        });
      }
    }
    return items;
  }

  /** The staff routes of 63.18 by `tail` (the path after `modules/social/`); null for any other path or method (the caller falls through). */
  function staff(method: string, tail: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
    const m = method.toUpperCase();
    let x: RegExpExecArray | null;
    if ((x = /^engagements\/([^/]+)\/reports$/.exec(tail))) return m === "POST" ? create(decodeURIComponent(x[1]), body, userId) : null;
    if (tail === "reports") return m === "GET" ? list(params, userId) : null;
    if ((x = /^reports\/([^/]+)$/.exec(tail))) return m === "GET" ? read(decodeURIComponent(x[1]), userId) : m === "PATCH" ? patch(decodeURIComponent(x[1]), body, userId) : null;
    if ((x = /^reports\/([^/]+)\/(ai-draft|approve|deliver)$/.exec(tail))) {
      if (m !== "POST") return null;
      const id = decodeURIComponent(x[1]);
      return x[2] === "ai-draft" ? aiDraftRoute(id, userId) : x[2] === "approve" ? approve(id, userId) : deliver(id, userId);
    }
    return null;
  }

  return { staff, needsYou, store, find };
}

// ── the demo's own store, pinned to globalThis like the other demo stores ────────────────────────────────────────────────────
const KEY = Symbol.for("gaiada.demoSocial.reports");
const demoStore: ReportStore = ((globalThis as Record<symbol, unknown>)[KEY] ??= seedReportStore()) as ReportStore;
export const demoReports = reportApi(demoStore);
// The Needs-you leg of the monthly reports comes from this store: the pipeline twin asks for it by tenant and person.
setDemoReportNeedsReader((tenantId, userId) => demoReports.needsYou(tenantId, userId));

/** The staff routes of 63.18 by `tail`; null when `tail` is none of them. */
export const demoReportsRoute = demoReports.staff;

/**
 * SCP-5d's Team dashboard reads the monthly reports of a period from here, never invents them (the team demo is wired to this at the merge train): every monthly report whose period is
 * `month` (`YYYY-MM`), with its state and when it last changed. A client with no row has no report yet.
 */
export const demoReportsFor = (month: string): Array<{ id: string; engagementId: string; period: string; status: string; updatedAt: string }> =>
  demoStore.reports.filter((r) => r.kind === "monthly" && r.period === month).map((r) => ({ id: r.id, engagementId: r.engagementId, period: month, status: r.status, updatedAt: r.updatedAt }));

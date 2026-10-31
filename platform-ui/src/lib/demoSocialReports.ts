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
// SCP-5 W5-A4 (BFF §63.24): the same store serves the six periodic kinds. A daily or weekly report is a SHORT kind (a summary and a next-period line, numbers live while a draft); quarterly, half-year and yearly
// follow the monthly's notes and plan. The demo company has every kind on and AI drafting on; Northwind is due daily, weekly, quarterly, half-year and yearly reports, the hotel weekly ones, the spa none. The seed
// holds the new kinds in Draft and Sent only, so the Needs-you counts of the monthly stay as they were. The run routes are `demoSocialReportRuns.ts`.
import { demoMonthShift, DEMO_SOCIAL_DEPT, PIPE_ENGAGEMENTS, PIPE_POSTS, SEAT_APPROVERS, allocStore, isClientContact, isDemoSocialApprover, setDemoReportNeedsReader, type DemoResult } from "./demoSocialPipeline";
import { demoPublishSocialReport } from "./demoClientReports";
import { todayIsoInDisplayZone } from "./format";
import { isIsoDate } from "./contracts";
import { monthTitle } from "./socialClient";
import {
  ACTION_MAX, ACTION_OWNERS, ACTION_PLAN_MAX, AREA_LABEL, NOTES_KINDS, NOTE_AREAS, NOTE_MAX, SHORT_MAX, isEditableState, isPeriodShape, notesAreComplete, type ReportAction, type ReportNotes,
} from "./socialReports";
import { PERIODIC_KINDS, addDays, anyPeriodLabel, isPeriodicKind, isShortKind, kindNoun, nextWord, periodLabel, periodOf, periodRange, rangeWords, shiftPeriod } from "./socialReportKinds";
import type { ReportDocument, ReportKpi, ReportSeries, ReportTable } from "./reports";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ID = /^[\w-]{1,64}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = ["draft", "in_review", "approved", "delivered"];
const KINDS: readonly string[] = [...PERIODIC_KINDS, "campaign", "adhoc"];
/** The periodic kinds each demo client is due besides the monthly (`report_kinds`, SCP-Q26), by position in the demo's engagements: Northwind, the spa, the hotel. */
const DUE_KINDS: ReadonlyArray<readonly string[]> = [["daily", "weekly", "quarterly", "semester", "yearly"], [], ["weekly"]];
export const dueKindsOf = (engagementId: string): readonly string[] => DUE_KINDS[PIPE_ENGAGEMENTS.findIndex((e) => e.id === engagementId)] ?? [];
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
  /** A short kind's next-period line (null on every other kind, or none written). */
  nextPeriod: string | null;
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

/** The days a report's period covers: a periodic kind's own range, else the month of its period, else the month so far. */
function rangeOf(kind: string, period: string | null): { start: string; end: string; known: boolean } {
  if (period && isPeriodicKind(kind)) { const r = periodRange(kind, period); if (r) return { ...r, known: true }; }
  if (period && PERIOD.test(period)) return { start: `${period}-01`, end: monthEnd(period), known: true };
  const start = todayIsoInDisplayZone().slice(0, 7) + "-01";
  return { start, end: start, known: false };
}
const statusWord = (s: string): string => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/** A period's frozen numbers for one client: followers, reach, impressions, engagements and the rate; a daily followers line; the best posts; Northwind's boosts as its own ad spend; and a short kind's own facts. */
function snapshotFor(engagementId: string, period: string | null, kind = "monthly"): Pick<ReportRec, "kpis" | "series" | "tables"> {
  const seed = hash(`${engagementId}:${period ?? ""}`);
  const range = rangeOf(kind, period);
  const days = range.known ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1 : 30;
  const scale = isPeriodicKind(kind) && kind !== "monthly" ? days / 30 : 1;
  const base = 1800 + (seed % 4000);
  const growth = 40 + (seed % 160);
  const reach = Math.max(1, Math.round((9000 + (seed % 21000)) * scale));
  const impressions = Math.round(reach * 1.6);
  const engagements = Math.round(reach * (0.03 + (seed % 40) / 1000));
  const rate = Math.round((engagements / reach) * 1000) / 10;
  const kpi = (metricKey: string, label: string, value: number, unit: ReportKpi["unit"]): ReportKpi => ({ metricKey, label, unit, value, appraisalSafe: false });
  const start = range.start;
  const points = Array.from({ length: days }, (_, i) => ({ t: addDays(start, i), v: base + Math.round((growth * i) / Math.max(1, days - 1)) }));
  const tables: ReportTable[] = [{
    key: "top_posts", label: "Top posts",
    columns: [{ key: "network", label: "Network" }, { key: "publishedAt", label: "Published" }, { key: "impressions", label: "Impressions", unit: "count", align: "right" }, { key: "likes", label: "Likes", unit: "count", align: "right" }],
    rows: [0, 1, 2].map((i) => ({ network: ["Instagram", "Facebook", "TikTok"][i], publishedAt: addDays(start, Math.min(days - 1, 3 + i * 7)), impressions: Math.round(impressions / (3 + i)), likes: Math.round(engagements / (4 + i)) })),
  }];
  if (engagementOf(engagementId)?.clientId === "cl-1") {
    tables.push({
      key: "ad_spend", label: "Paid boosts (your own ad spend)",
      columns: [{ key: "post", label: "Post" }, { key: "spend", label: "Spend", align: "right" }, { key: "currency", label: "Currency" }],
      rows: [{ post: "Harvest collection arrives", spend: 450000, currency: "IDR" }], totalRow: { post: "Total", spend: 450000, currency: "IDR" },
    });
  }
  const kpis = [kpi("followers_total", "Followers", base + growth, "count"), kpi("reach_month", "Reach", reach, "count"), kpi("impressions_month", "Impressions", impressions, "count"),
    kpi("engagements_month", "Engagements", engagements, "count"), kpi("engagement_rate", "Engagement rate", rate, "percent")];
  if (isShortKind(kind) && range.known) {
    // A short report's own facts (BFF §63.24.1): the posts the client approved, the best post by reach, and the pipeline's posts dated in the next day or week.
    const mine = PIPE_POSTS.filter((p) => p.engagementId === engagementId && !p.archivedAt);
    kpis.push(kpi("posts_approved_period", "Posts approved by the client", seed % 4, "count"));
    tables.push({
      key: "best_post", label: "Best post by reach",
      columns: [{ key: "post", label: "Post" }, { key: "network", label: "Network" }, { key: "publishedAt", label: "Published" }, { key: "reach", label: "Reach", unit: "count", align: "right" }],
      rows: [{ post: mine[0]?.title ?? "A post of the period", network: "Instagram", publishedAt: addDays(start, Math.min(days - 1, 1)), reach: Math.round(reach / 3) }],
    });
    const nextStart = addDays(range.end, 1);
    const nextEnd = addDays(range.end, kind === "daily" ? 1 : 7);
    const coming = mine.filter((p) => p.scheduledAt && p.scheduledAt.slice(0, 10) >= nextStart && p.scheduledAt.slice(0, 10) <= nextEnd).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    if (coming.length > 0) {
      tables.push({
        key: "next_period", label: kind === "daily" ? "Coming up the next day" : "Coming up the next week",
        columns: [{ key: "title", label: "Post" }, { key: "format", label: "Format" }, { key: "scheduledAt", label: "Scheduled" }, { key: "phaseLabel", label: "Where it is" }],
        rows: coming.map((p) => ({ postId: p.id, title: p.title, format: p.format, scheduledAt: p.scheduledAt, phase: p.pipelineStatus, phaseLabel: statusWord(p.pipelineStatus) })),
      });
    }
  }
  return { kpis, series: [{ key: "followers", label: "Followers", unit: "count", kind: "line", points }], tables };
}

const kpiValue = (r: ReportRec, label: string): number | null => r.kpis.find((k) => k.label === label)?.value ?? null;

/** The plain template, from the month's own numbers only (the server's `templateNotes` and `templateActionPlan`). */
function templateDraft(r: ReportRec): { narrativeMd: string; notes: Required<ReportNotes>; actionPlan: ReportAction[] } {
  const label = r.period ? anyPeriodLabel(r.kind, r.period) : "the period";
  const span = r.kind === "monthly" || !isPeriodicKind(r.kind) ? "the month" : "the period";
  const followers = kpiValue(r, "Followers");
  const rate = kpiValue(r, "Engagement rate");
  const reach = kpiValue(r, "Reach");
  return {
    narrativeMd: `Performance summary for ${label}. Followers stood at ${followers} at the end of ${span}; posts reached ${reach} accounts and the engagement rate was ${rate}%.`,
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

/** A short report's summary and next-period line, from its own numbers only (the demo's twin of the model's answer, or of the plain template when `ai` is false). */
function shortDraft(r: ReportRec, clientName: string, ai: boolean): { narrativeMd: string; nextPeriod: string } {
  const label = anyPeriodLabel(r.kind, r.period);
  const reach = kpiValue(r, "Reach");
  const approved = kpiValue(r, "Posts approved by the client") ?? 0;
  const next = r.tables.find((t) => t.key === "next_period")?.rows ?? [];
  const word = nextWord(r.kind);
  const posts = `${approved} ${approved === 1 ? "post" : "posts"}`;
  return {
    narrativeMd: ai ? `${clientName} had a steady ${r.kind === "daily" ? "day" : "week"}. Reach was ${reach}, and the client approved ${posts}.` : `Summary for ${label}. Posts reached ${reach} accounts and the client approved ${posts}.`,
    nextPeriod: next.length > 0 ? `${next.length} ${next.length === 1 ? "post is" : "posts are"} dated for the next ${word}: ${next.slice(0, 3).map((t) => String(t.title)).join(", ")}.` : `Nothing is dated for the next ${word} yet.`,
  };
}

/** "Draft with AI" for a client whose numbers are real: the same facts, in the brand's voice (the demo's twin of the model's answer). */
function aiDraft(r: ReportRec, clientName: string): { narrativeMd: string; notes: Required<ReportNotes>; actionPlan: ReportAction[] } {
  const t = templateDraft(r);
  const label = r.period ? anyPeriodLabel(r.kind, r.period) : "the period";
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
    const kind = o.kind ?? "monthly";
    const snap = snapshotFor(engagementId, period, kind);
    const rec: ReportRec = {
      id: `soc-rep-${++s.seq}`, engagementId, period, kind, createdAt: hoursAgo(72), updatedAt: hoursAgo(72), approvedAt: null, deliveredAt: null, narrativeMd: "", narrativeSource: "deterministic",
      notes: {}, actionPlan: [], simulated: isSimulatedClient(engagementId), nextPeriod: null, clientReportId: null, filename: null, ...snap, ...o,
    };
    const t = templateDraft(rec);
    if (!rec.narrativeMd) rec.narrativeMd = isShortKind(rec.kind) ? shortDraft(rec, engagementOf(engagementId)?.clientName ?? "A client", true).narrativeMd : t.narrativeMd;
    if (isShortKind(rec.kind) && o.nextPeriod === undefined) rec.nextPeriod = shortDraft(rec, "", true).nextPeriod;
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
  // SCP-5 W5-A4: a little of every other kind, in Draft and Sent (older than the monthly's rows, so the monthly's own tests read the same ones first).
  const today = todayIsoInDisplayZone();
  const wk = periodOf("weekly", today);
  const lastWk = shiftPeriod("weekly", wk, -1)!;
  const lastQ = shiftPeriod("quarterly", periodOf("quarterly", today), -1)!;
  const lastH = shiftPeriod("semester", periodOf("semester", today), -1)!;
  const lastY = shiftPeriod("yearly", periodOf("yearly", today), -1)!;
  if (north) {
    const kindFull = (kind: string, period: string) => full({ kpis: snapshotFor(north.id, period, kind).kpis });
    add(north.id, addDays(today, -1), { kind: "daily", status: "draft", createdAt: hoursAgo(130) });
    add(north.id, lastWk, { kind: "weekly", status: "delivered", createdAt: hoursAgo(200), approvedAt: hoursAgo(150), deliveredAt: hoursAgo(140), filename: `social-report-${lastWk}-b2c3d4e5.pdf` });
    add(north.id, wk, { kind: "weekly", status: "draft", createdAt: hoursAgo(132) });
    const q = kindFull("quarterly", lastQ);
    add(north.id, lastQ, { kind: "quarterly", status: "draft", createdAt: hoursAgo(134), notes: { followers: q.notes.followers }, actionPlan: q.actionPlan.slice(0, 1) });
    add(north.id, lastH, { kind: "semester", status: "delivered", createdAt: hoursAgo(24 * 20), approvedAt: hoursAgo(24 * 15), deliveredAt: hoursAgo(24 * 14), filename: `social-report-${lastH}-c3d4e5f6.pdf`, ...kindFull("semester", lastH) });
    add(north.id, lastY, { kind: "yearly", status: "draft", createdAt: hoursAgo(136) });
  }
  if (hotel) add(hotel.id, lastWk, { kind: "weekly", status: "draft", createdAt: hoursAgo(138) });
  return s;
}

// ── the document ─────────────────────────────────────────────────────────────────────────────

const AREA_TABLE_LABEL: Record<(typeof NOTE_AREAS)[number], string> = AREA_LABEL;

function documentOf(r: ReportRec, clientName: string): ReportDocument {
  const { start, end } = rangeOf(r.kind, r.period);
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
      tenantId: "co-agency", grain: "company", scopeRef: r.engagementId, scopeName: clientName, periodKind: r.kind === "monthly" ? "month" : "custom", periodStart: start, periodEnd: end,
      dayCount: Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1, periodLabel: anyPeriodLabel(r.kind, r.period), generatedAt: new Date().toISOString(), sealed: false,
    },
    kpis: r.kpis, series: r.series, distributions: [], tables, highlights: [],
    // As the server prints it: a short report's next-period line sits under its summary.
    narrative: { source: r.narrativeSource, text: r.nextPeriod && /\S/.test(r.nextPeriod) ? `${r.narrativeMd}\n\nNext ${nextWord(r.kind)}: ${r.nextPeriod.trim()}` : r.narrativeMd },
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
  const complete = (r: ReportRec): boolean => !NOTES_KINDS.includes(r.kind) || notesAreComplete(r.notes);
  const today = (): string => todayIsoInDisplayZone();
  /** The day a report falls due (BFF §63.24.1): a short kind the first working day after its period; the notes kinds the client's report day in the month after; none for campaign and ad hoc. */
  const dueOf = (r: ReportRec): string | null => {
    if (!isPeriodicKind(r.kind) || !r.period) return null;
    const range = periodRange(r.kind, r.period);
    if (!range) return null;
    if (isShortKind(r.kind)) {
      let d = addDays(range.end, 1);
      while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
      return d;
    }
    const day = allocStore.byEngagement[r.engagementId]?.reportDueDay ?? null;
    if (day === null) return null;
    const month = demoMonthShift(range.end.slice(0, 7), 1);
    return `${month}-${String(Math.min(day, Number(monthEnd(month).slice(8, 10)))).padStart(2, "0")}`;
  };
  const live = (r: ReportRec): boolean => isShortKind(r.kind) && r.status === "draft";

  const row = (r: ReportRec) => ({
    id: r.id, engagementId: r.engagementId, clientName: nameOf(r), period: r.period, kind: r.kind, status: r.status, createdAt: r.createdAt, approvedAt: r.approvedAt, deliveredAt: r.deliveredAt,
    notesComplete: complete(r), simulated: r.simulated, due: dueOf(r), summaryPresent: /\S/.test(r.narrativeMd), live: live(r),
  });
  const existing = (r: ReportRec) => ({
    id: r.id, status: r.status, metrics: { kpis: r.kpis, series: r.series, tables: r.tables }, narrativeMd: r.narrativeMd, notes: r.notes, actionPlan: r.actionPlan, nextPeriod: r.nextPeriod, simulated: r.simulated, draftedVia: "existing",
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
    // A new periodic kind: its period in its format, a real day or week, not in the future (400 `invalid_field`), and ended when its numbers freeze at create (400 `period_not_over`).
    const isNew = isPeriodicKind(kind) && kind !== "monthly";
    if (isNew) {
      const range = period === null ? null : periodRange(kind, period);
      if (!range || range.start > today()) return err(400, "invalid_field", { field: "period" });
      if (!isShortKind(kind) && range.end >= today()) return err(400, "period_not_over");
    }
    const prior = period !== null && (kind === "monthly" || isNew) ? store.reports.find((r) => r.engagementId === engagementId && r.kind === kind && r.period === period) : undefined;
    if (prior) return ok(existing(prior), 201);
    store.seq += 1;
    const snap = snapshotFor(engagementId, period, kind);
    const rec: ReportRec = {
      id, engagementId, period, kind, status: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), approvedAt: null, deliveredAt: null, narrativeMd: "", narrativeSource: "deterministic",
      notes: {}, actionPlan: [], simulated: isSimulatedClient(engagementId), nextPeriod: null, clientReportId: null, filename: null, ...snap,
    };
    // The report is drafted by the model when the gateway answers and by the plain template when it does not: a short kind's summary and next-period line, a long kind's narrative, notes and plan.
    const via = rec.simulated ? "fallback" : "ai";
    if (isShortKind(kind)) {
      const sd = shortDraft(rec, e.clientName, via === "ai");
      rec.narrativeMd = sd.narrativeMd;
      rec.nextPeriod = sd.nextPeriod;
    } else {
      const draft = via === "ai" ? aiDraft(rec, e.clientName) : templateDraft(rec);
      rec.narrativeMd = draft.narrativeMd;
      if (NOTES_KINDS.includes(kind)) { rec.notes = draft.notes; rec.actionPlan = draft.actionPlan; }
    }
    rec.narrativeSource = via === "ai" ? "ai" : "deterministic";
    store.reports.push(rec);
    return ok({ id, status: "draft", metrics: { kpis: rec.kpis, series: rec.series, tables: rec.tables }, narrativeMd: rec.narrativeMd, notes: rec.notes, actionPlan: rec.actionPlan, nextPeriod: rec.nextPeriod, simulated: rec.simulated, draftedVia: via, groundedOn: [] }, 201);
  }

  function list(params: URLSearchParams, userId: string): DemoResult {
    if (!canRead(userId)) return denied("read");
    const engagementId = params.get("engagementId");
    const status = params.get("status");
    const period = params.get("period");
    const kind = params.get("kind");
    if (kind !== null && !KINDS.includes(kind)) return err(400, "invalid_field", { field: "kind" });
    if (engagementId !== null && !ID.test(engagementId)) return err(400, "invalid_field", { field: "engagementId" });
    if (status !== null && !STATUSES.includes(status)) return err(400, "invalid_field", { field: "status" });
    if (period !== null && !isPeriodShape(period)) return err(400, "invalid_field", { field: "period" });
    const rows = store.reports
      .filter((r) => (!kind || r.kind === kind) && (!engagementId || r.engagementId === engagementId) && (!status || r.status === status) && (!period || r.period === period))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return ok({ reports: rows.map(row) });
  }

  function read(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    if (!canRead(userId)) return denied("read");
    return ok({
      id: r.id, status: r.status, engagementId: r.engagementId, kind: r.kind, period: r.period, notes: r.notes, actionPlan: r.actionPlan, nextPeriod: r.nextPeriod, simulated: r.simulated,
      live: live(r), due: dueOf(r), notesComplete: complete(r), canApprove: isDemoSocialApprover(userId), canDeliver: isDemoSocialApprover(userId), document: documentOf(r, nameOf(r)),
    });
  }

  function patch(id: string, body: string | undefined, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    let b: Record<string, unknown>;
    try { b = body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { b = {}; }
    const sendingBack = b.status === "draft";
    const editing = b.narrativeMd !== undefined || b.notes !== undefined || b.actionPlan !== undefined || b.nextPeriod !== undefined;
    if (sendingBack) {
      if (!isDemoSocialApprover(userId)) return denied("approve");
      if (editing && !canWrite(userId)) return denied("update");
    } else if (!canWrite(userId)) return denied("update");

    const short = isShortKind(r.kind);
    if (b.narrativeMd !== undefined && (typeof b.narrativeMd !== "string" || (short && b.narrativeMd.length > SHORT_MAX))) return err(400, "invalid_field", { field: "narrativeMd" });
    let notes: ReportNotes | undefined;
    if (b.notes !== undefined) {
      const v = short ? null : validateNotes(b.notes);
      if (!v) return err(400, "invalid_field", { field: "notes" });
      notes = v;
    }
    let plan: ReportAction[] | undefined;
    if (b.actionPlan !== undefined) {
      const v = short ? null : validateActionPlan(b.actionPlan);
      if (!v) return err(400, "invalid_field", { field: "actionPlan" });
      plan = v;
    }
    if (b.nextPeriod !== undefined && (!short || (b.nextPeriod !== null && (typeof b.nextPeriod !== "string" || b.nextPeriod.length > SHORT_MAX)))) return err(400, "invalid_field", { field: "nextPeriod" });

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
    if (b.nextPeriod !== undefined) r.nextPeriod = b.nextPeriod as string | null;
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
    if (isShortKind(r.kind)) {
      const sd = shortDraft(r, nameOf(r), !simulated);
      return ok({ narrativeMd: sd.narrativeMd, nextPeriod: sd.nextPeriod, draftedVia: simulated ? "template" : "ai" });
    }
    const draft = simulated ? templateDraft(r) : aiDraft(r, nameOf(r));
    return ok({ narrativeMd: draft.narrativeMd, notes: draft.notes, actionPlan: draft.actionPlan, draftedVia: simulated ? "template" : "ai" });
  }

  function approve(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return err(404, "report not found");
    if (!isDemoSocialApprover(userId)) return denied("approve");
    if (r.status !== "in_review") return err(400, "cannot_approve_from_this_status");
    if (isShortKind(r.kind) && !/\S/.test(r.narrativeMd)) return err(400, "summary_missing");
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
      sourceId: r.id, clientId: e?.clientId ?? "cl-1", clientName: nameOf(r),
      title: r.kind !== "monthly" && isPeriodicKind(r.kind) && r.period ? `${kindNoun(r.kind)}, ${r.kind === "weekly" ? rangeWords(rangeOf(r.kind, r.period)) : periodLabel(r.kind, r.period)}`
        : r.period ? `Social media performance, ${monthTitle(r.period)}` : "Social media performance",
      periodStart: r.period && rangeOf(r.kind, r.period).known ? rangeOf(r.kind, r.period).start : when.slice(0, 10), periodEnd: r.period && rangeOf(r.kind, r.period).known ? rangeOf(r.kind, r.period).end : when.slice(0, 10), filename,
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
          title: r.period ? `${kindNoun(r.kind)}, ${anyPeriodLabel(r.kind, r.period)}` : "Report", clientName: e?.clientName ?? "A client", since: check ? r.createdAt : r.approvedAt ?? r.createdAt,
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

  return { staff, needsYou, store, find, create, canWrite };
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

/** SCP-5d: every report in the HoD check (`in_review`), any kind and any period, oldest change first: the Team dashboard's "Report to check" is today's state, as the server reads it. */
export const demoReportsInReview = (): Array<{ id: string; engagementId: string; kind: string; period: string | null; updatedAt: string }> =>
  demoStore.reports.filter((r) => r.status === "in_review")
    .map((r) => ({ id: r.id, engagementId: r.engagementId, kind: r.kind, period: r.period ?? null, updatedAt: r.updatedAt }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

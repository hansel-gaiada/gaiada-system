// SCP-5a (BFF §63.18) — the Social Media monthly report: the types of every answer, their defensive parsing, the words for the four states and for every refusal, the form's own
// checks and the pure rules of the two pages. No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialReports-data.ts` (server-only, `ReadResult`), the writes in `lib/socialReportsActions.ts` ("use server"); DEMO_MODE answers every route from
// `lib/demoSocialReports.ts`, in the server's order of checks.
//
// THE FOUR STATES are the design's: Draft (`draft`), HoD check (`in_review`), Ready (`approved`), Sent (`delivered`). WHO DOES WHAT (SCP-Q20): the officer writes, edits and submits;
// the four approvers (the HoD and GM seats, the owner, the superadmin) check (approve, or send back) and send. The server's `canApprove` and `canDeliver` on the report read decide which
// buttons are live; the officer's own writes carry no flag, so those buttons are drawn and the server's 403 is said in words. A parsed answer that is the wrong shape throws, and the reader
// turns that into "cannot tell", never into a plausible empty page.
import { isIsoDate } from "./contracts";
import type { ReportDocument } from "./reports";
import { monthTitle, shiftMonth } from "./socialClient";
import { refusalText, type Refusal } from "./socialPipeline";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── The states ────────────────────────────────────────────────────────────────────────────────────

export const REPORT_STATES = ["draft", "in_review", "approved", "delivered"] as const;
export type ReportState = (typeof REPORT_STATES)[number];
/** The design's four words. */
export const REPORT_STATE_WORDS: Readonly<Record<ReportState, string>> = { draft: "Draft", in_review: "HoD check", approved: "Ready", delivered: "Sent" };
/** A state in words; one the page does not know is shown as it came, never dropped. */
export const reportStateWords = (s: string): string => REPORT_STATE_WORDS[s as ReportState] ?? s;
export const isReportState = (s: unknown): s is ReportState => typeof s === "string" && (REPORT_STATES as readonly string[]).includes(s);
/** Edited while `draft` or `in_review` (the server's `report_not_editable` otherwise). */
export const isEditableState = (s: string): boolean => s === "draft" || s === "in_review";

/** What each state means for the person, in one sentence. */
export const REPORT_STATE_HELP: Readonly<Record<ReportState, string>> = {
  draft: "The officer is writing it. Submit it for the HoD check when the three areas and the action plan are ready.",
  in_review: "Waiting for the HoD check. One of the Social Media head, the GM, the owner or the superadmin approves it or sends it back to draft.",
  approved: "Ready to send. One of the Social Media head, the GM, the owner or the superadmin sends it to the client.",
  delivered: "Sent. The PDF is published to the client's portal reports and can no longer be changed.",
};

// ── Limits (BFF §63.1 file 9, mirrored from the server's `report-notes.ts`) ───────────────────────────

export const NOTE_AREAS = ["followers", "engagement", "audience"] as const;
export type NoteArea = (typeof NOTE_AREAS)[number];
export const AREA_LABEL: Readonly<Record<NoteArea, string>> = { followers: "Followers", engagement: "Engagement", audience: "Audience" };
export const NOTE_MAX = 500;
export const ACTION_MAX = 300;
export const ACTION_PLAN_MAX = 10;
export const ACTION_OWNERS = ["agency", "client"] as const;
export type ActionOwner = (typeof ACTION_OWNERS)[number];
export const OWNER_LABEL: Readonly<Record<ActionOwner, string>> = { agency: "Agency", client: "Client" };

export interface ReportNote { insight: string; suggestion: string }
export type ReportNotes = Partial<Record<NoteArea, ReportNote>>;
export interface ReportAction { action: string; owner: ActionOwner; due?: string }

const hasText = (s: unknown): boolean => typeof s === "string" && /\S/.test(s);

/** The server's rule for the HoD check: every area has an insight and a suggestion that are not blank. */
export function notesAreComplete(notes: ReportNotes): boolean {
  return NOTE_AREAS.every((a) => hasText(notes[a]?.insight) && hasText(notes[a]?.suggestion));
}

/** What is still missing, per area, for the person to read. An area with both written is not listed. */
export function missingNotes(notes: ReportNotes): Array<{ area: NoteArea; insight: boolean; suggestion: boolean }> {
  return NOTE_AREAS.flatMap((area) => {
    const insight = !hasText(notes[area]?.insight);
    const suggestion = !hasText(notes[area]?.suggestion);
    return insight || suggestion ? [{ area, insight, suggestion }] : [];
  });
}

/** "Followers: the insight and the suggestion are missing." */
export function missingNoteLine(m: { area: NoteArea; insight: boolean; suggestion: boolean }): string {
  const what = m.insight && m.suggestion ? "the insight and the suggestion are" : m.insight ? "the insight is" : "the suggestion is";
  return `${AREA_LABEL[m.area]}: ${what} missing.`;
}

// ── A period ──────────────────────────────────────────────────────────────────────────────────────

export const isPeriod = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
export const periodWords = (period: string | null, kind = "monthly"): string => (period && isPeriod(period) ? monthTitle(period) : kind === "monthly" ? "No period" : "Custom period");
/** The month a report is DUE for on `todayIso`: last month's (the due day is in the month after its period, BFF §63.18 "Reports due"). */
export const dueReportPeriod = (todayIso: string): string => shiftMonth(todayIso.slice(0, 7), -1);

// ── The list (GET reports) ────────────────────────────────────────────────────────────────────────

export interface SocialReportRow {
  id: string;
  engagementId: string;
  clientName: string;
  period: string | null;
  kind: string;
  status: string;
  createdAt: string | null;
  approvedAt: string | null;
  deliveredAt: string | null;
  /** True when the HoD check's notes rule is met (always true for a campaign or ad hoc report, which has no notes to complete). */
  notesComplete: boolean;
  simulated: boolean;
}

export function asReportRow(raw: unknown): SocialReportRow {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.status !== "string" || typeof raw.engagementId !== "string") throw new Error("report: not a report row");
  return {
    id: raw.id, engagementId: raw.engagementId, clientName: str(raw.clientName) ?? "A client", period: str(raw.period), kind: str(raw.kind) ?? "monthly", status: raw.status,
    createdAt: str(raw.createdAt), approvedAt: str(raw.approvedAt), deliveredAt: str(raw.deliveredAt), notesComplete: raw.notesComplete === true, simulated: raw.simulated === true,
  };
}

/** `GET reports?engagementId=&status=&period=`: `{ reports: [...] }`. */
export function asReportList(raw: unknown): SocialReportRow[] {
  if (!isObj(raw) || !Array.isArray(raw.reports)) throw new Error("reports: not a list of reports");
  return raw.reports.map(asReportRow);
}

/** Newest period first, then by client, so a month's reports sit together. */
export function sortReports(rows: readonly SocialReportRow[]): SocialReportRow[] {
  return [...rows].sort((a, b) => (b.period ?? "").localeCompare(a.period ?? "") || a.clientName.localeCompare(b.clientName) || a.id.localeCompare(b.id));
}

/** The periods the list's filter offers: the ones the listed reports carry, newest first. */
export function periodsOf(rows: readonly SocialReportRow[]): string[] {
  return [...new Set(rows.map((r) => r.period).filter((p): p is string => p !== null))].sort().reverse();
}

// ── One report (GET reports/:id) ──────────────────────────────────────────────────────────────────

export interface SocialReportDetail {
  id: string;
  status: string;
  engagementId: string;
  kind: string;
  period: string | null;
  notes: ReportNotes;
  actionPlan: ReportAction[];
  simulated: boolean;
  notesComplete: boolean;
  canApprove: boolean;
  canDeliver: boolean;
  /** The document the PDF renders: the frozen numbers, the narrative, the notes and the plan as tables, and `simulated`. */
  document: ReportDocument;
}

function asNotes(raw: unknown): ReportNotes {
  const out: ReportNotes = {};
  if (!isObj(raw)) return out;
  for (const a of NOTE_AREAS) {
    const n = raw[a];
    if (isObj(n)) out[a] = { insight: text(n.insight), suggestion: text(n.suggestion) };
  }
  return out;
}

function asAction(raw: unknown): ReportAction | null {
  if (!isObj(raw) || typeof raw.action !== "string") return null;
  const owner: ActionOwner = raw.owner === "client" ? "client" : "agency";
  const due = typeof raw.due === "string" && isIsoDate(raw.due) ? raw.due : undefined;
  return { action: raw.action, owner, ...(due ? { due } : {}) };
}
const asActionPlan = (raw: unknown): ReportAction[] => arr(raw).map(asAction).filter((a): a is ReportAction => a !== null);

/** The document must be a document: a header and its lists. Anything else throws, and the page says it cannot tell. */
function asDocument(raw: unknown): ReportDocument {
  if (!isObj(raw) || !isObj(raw.header) || !isObj(raw.narrative) || !Array.isArray(raw.kpis) || !Array.isArray(raw.tables) || !Array.isArray(raw.series)) {
    throw new Error("report: the document is not a report document");
  }
  return { ...(raw as unknown as ReportDocument), distributions: arr(raw.distributions) as ReportDocument["distributions"], highlights: arr(raw.highlights) as ReportDocument["highlights"] };
}

export function asReportDetail(raw: unknown): SocialReportDetail {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") throw new Error("report: not a report read");
  return {
    id: raw.id, status: raw.status, engagementId: str(raw.engagementId) ?? "", kind: str(raw.kind) ?? "monthly", period: str(raw.period), notes: asNotes(raw.notes),
    actionPlan: asActionPlan(raw.actionPlan), simulated: raw.simulated === true, notesComplete: raw.notesComplete === true, canApprove: raw.canApprove === true,
    canDeliver: raw.canDeliver === true, document: asDocument(raw.document),
  };
}

/** The tables of the document the page does not draw as numbers: the notes and the plan are the form's own, so drawing them twice would show the old text beside the new. */
export const FORM_TABLE_KEYS: readonly string[] = ["notes", "action_plan"];
export function numbersDocument(doc: ReportDocument): ReportDocument {
  return { ...doc, tables: doc.tables.filter((t) => !FORM_TABLE_KEYS.includes(t.key)) };
}

// ── "Draft with AI" (POST reports/:id/ai-draft) and "Draft this month's report" (POST engagements/:id/reports) ──

export interface ReportProposal {
  narrativeMd: string;
  notes: Record<NoteArea, ReportNote>;
  actionPlan: ReportAction[];
  /** `ai`: the model's answer was used. `template`: the gateway was down, or its answer failed the number check, and the plain template was used. */
  draftedVia: "ai" | "template";
}

export function asProposal(raw: unknown): ReportProposal {
  if (!isObj(raw) || typeof raw.narrativeMd !== "string" || !isObj(raw.notes)) throw new Error("ai-draft: not a proposal");
  const notes = asNotes(raw.notes);
  return {
    narrativeMd: raw.narrativeMd,
    notes: { followers: notes.followers ?? { insight: "", suggestion: "" }, engagement: notes.engagement ?? { insight: "", suggestion: "" }, audience: notes.audience ?? { insight: "", suggestion: "" } },
    actionPlan: asActionPlan(raw.actionPlan),
    draftedVia: raw.draftedVia === "ai" ? "ai" : "template",
  };
}

export interface CreatedReport {
  id: string;
  status: string;
  simulated: boolean;
  /** `existing`: the engagement already had this month's report, which is returned as it is. `fallback` and `template` both mean the plain template. */
  draftedVia: string;
}
export function asCreatedReport(raw: unknown): CreatedReport {
  if (!isObj(raw) || typeof raw.id !== "string") throw new Error("report create: not a report");
  return { id: raw.id, status: str(raw.status) ?? "draft", simulated: raw.simulated === true, draftedVia: str(raw.draftedVia) ?? "ai" };
}

/** What the page says about a draft's source. The template is a plain, honest fallback and says so. */
export function draftedViaWords(via: string): string {
  switch (via) {
    case "ai": return "Drafted with AI from the month's numbers and the client's brand notes. Read it, change what you want, and save.";
    case "template": case "fallback": return "The AI could not be used just now (it was down, or its answer stated a number it was not given), so this is the plain template from the month's numbers. Read it, change what you want, and save.";
    case "existing": return "This client already has a report for that month, so it is opened as it is.";
    default: return "Drafted.";
  }
}

// ── The form (what the officer types) and its checks ──────────────────────────────────────────────

export interface ReportForm {
  narrative: string;
  notes: Record<NoteArea, ReportNote>;
  actions: Array<{ action: string; owner: ActionOwner; due: string }>;
}

export function formFromDetail(d: Pick<SocialReportDetail, "notes" | "actionPlan" | "document">): ReportForm {
  const note = (a: NoteArea): ReportNote => ({ insight: d.notes[a]?.insight ?? "", suggestion: d.notes[a]?.suggestion ?? "" });
  return {
    narrative: d.document.narrative.text,
    notes: { followers: note("followers"), engagement: note("engagement"), audience: note("audience") },
    actions: d.actionPlan.map((a) => ({ action: a.action, owner: a.owner, due: a.due ?? "" })),
  };
}

/** A proposal laid over the form: it fills the fields and saves nothing. */
export function formFromProposal(p: ReportProposal): ReportForm {
  return { narrative: p.narrativeMd, notes: { ...p.notes }, actions: p.actionPlan.map((a) => ({ action: a.action, owner: a.owner, due: a.due ?? "" })) };
}

export const emptyAction = (): ReportForm["actions"][number] => ({ action: "", owner: "agency", due: "" });

export function sameForm(a: ReportForm, b: ReportForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type FormCheck = { ok: true; body: { narrativeMd: string; notes: ReportNotes; actionPlan: ReportAction[] } } | { ok: false; field: string; message: string };

/** The server's own shapes, checked before the request: at most 500 characters per note, at most 10 actions of 1 to 300 characters, an owner of agency or client, a real date. */
export function buildReportBody(f: ReportForm): FormCheck {
  for (const a of NOTE_AREAS) {
    for (const k of ["insight", "suggestion"] as const) {
      if (f.notes[a][k].length > NOTE_MAX) return { ok: false, field: `notes.${a}.${k}`, message: `${AREA_LABEL[a]}: the ${k} is over ${NOTE_MAX} characters.` };
    }
  }
  if (f.actions.length > ACTION_PLAN_MAX) return { ok: false, field: "actionPlan", message: `The action plan has at most ${ACTION_PLAN_MAX} actions.` };
  const plan: ReportAction[] = [];
  for (let i = 0; i < f.actions.length; i++) {
    const row = f.actions[i];
    const n = i + 1;
    if (!hasText(row.action)) return { ok: false, field: `actionPlan.${i}.action`, message: `Action ${n}: write the action, or remove the row.` };
    if (row.action.length > ACTION_MAX) return { ok: false, field: `actionPlan.${i}.action`, message: `Action ${n} is over ${ACTION_MAX} characters.` };
    if (row.due !== "" && !isIsoDate(row.due)) return { ok: false, field: `actionPlan.${i}.due`, message: `Action ${n}: the due date is not a real date.` };
    plan.push({ action: row.action, owner: row.owner, ...(row.due !== "" ? { due: row.due } : {}) });
  }
  return { ok: true, body: { narrativeMd: f.narrative, notes: { followers: { ...f.notes.followers }, engagement: { ...f.notes.engagement }, audience: { ...f.notes.audience } }, actionPlan: plan } };
}

// ── Who may, in words ─────────────────────────────────────────────────────────────────────────────

/** SCP-Q20: the four check and send; the officer writes and submits. Shown on a disabled button and under a 403. */
export const CHECK_SEND_REASON = "Only the Social Media head, the GM, the owner and the superadmin check and send a report. The officer writes it and submits it.";
export const WRITE_REASON = "Only this client's officer and the Social Media approvers can write the report. The Social Media head or the GM can change who the officer is on the Allocation page.";
export const DRAFT_REASON = "Only the client's officer and the Social Media approvers can draft a report.";

export type ReportWriteKind = "create" | "save" | "submit" | "send_back" | "ai_draft" | "approve" | "deliver";

/** The refusal words by code (BFF §63.18: the SMM-23 codes stay, `notes_incomplete` is new). */
export const REPORT_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  invalid_kind: "A report is a monthly, campaign or ad hoc report.",
  internal_client_no_reports: "Our own company is not a client, so it gets no client reports.",
  cannot_submit_from_this_status: "Only a draft can be submitted for the HoD check. The report has moved; the page has been refreshed.",
  cannot_send_back_from_this_status: "Only a report in the HoD check can be sent back to draft. The report has moved; the page has been refreshed.",
  invalid_status_transition: "A report cannot move that way.",
  report_not_editable: "A report can be changed only while it is a draft or in the HoD check. This one has moved on; the page has been refreshed.",
  status_changed_concurrently: "The report changed while you were looking at it. The page has been refreshed.",
  cannot_approve_from_this_status: "Only a report in the HoD check can be approved. It has moved; the page has been refreshed.",
  internal_client_not_deliverable: "Our own company is not a client, so this report cannot be sent.",
  cannot_deliver_from_this_status: "Only a Ready report can be sent. It has moved; the page has been refreshed.",
  pdf_render_not_configured: "The PDF maker is not set up for this company yet, so the report cannot be sent. Nothing was sent.",
  pdf_render_failed: "The PDF could not be made just now. Nothing was sent. Try again in a minute.",
  notes_incomplete: "The HoD check cannot pass yet: an area is missing its insight or its suggestion. Send the report back to draft, finish the notes and submit it again.",
  id_invalid: "That is not a report.",
  engagement_id_invalid: "That is not a client.",
  session_expired: "Session expired — sign in again.",
  no_company: "Choose a company first.",
};

const FIELD_WORDS: Readonly<Record<string, string>> = {
  notes: `The notes are not valid. Each area has an insight and a suggestion of at most ${NOTE_MAX} characters.`,
  actionPlan: `The action plan is not valid. It has at most ${ACTION_PLAN_MAX} actions, each of 1 to ${ACTION_MAX} characters, owned by the agency or the client, with a real due date or none.`,
  narrativeMd: "The narrative is not valid.",
  status: "The status filter is not valid.",
  period: "The period is not valid. Use a month, such as 2026-09.",
  engagementId: "The client is not valid.",
};

function forbiddenWords(kind: ReportWriteKind): string {
  switch (kind) {
    case "approve": case "send_back": case "deliver": return CHECK_SEND_REASON;
    case "create": return DRAFT_REASON;
    default: return WRITE_REASON;
  }
}

/** A refusal in a sentence. A 403 says who may do what was asked; a 404 says the report or client is gone. The code stays the contract; this is the words. */
export function reportRefusalText(r: Refusal, kind: ReportWriteKind = "save"): string {
  if (r.status === 403) return r.reason === "assurance_required" ? refusalText(r) : `You cannot do this. ${forbiddenWords(kind)}`;
  if (r.status === 404) return /engagement/i.test(r.error) ? "That client was not found, or is not yours to see." : "That report was not found. It may have been removed.";
  if (r.error === "invalid_field" || r.error === "missing_field") return (r.field && FIELD_WORDS[r.field]) || refusalText(r);
  return REPORT_REFUSAL_WORDS[r.error] ?? refusalText(r);
}

// ── The pages' rules ──────────────────────────────────────────────────────────────────────────────

export const REPORTS_LIST_PATH = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/social-reports`;
export const reportHref = (deptId: string, reportId: string): string => `${REPORTS_LIST_PATH(deptId)}/${encodeURIComponent(reportId)}`;

/** The list's filters, from the page's query (`status` and `period`): a value that is not one is ignored, so a mistyped link shows the whole list. */
export function parseReportFilters(q: { status?: string | string[]; period?: string | string[] }): { status: ReportState | null; period: string | null } {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : v?.[0]);
  const s = one(q.status);
  const p = one(q.period);
  return { status: isReportState(s) ? s : null, period: isPeriod(p) ? p : null };
}

export function filtersHref(deptId: string, f: { status: string | null; period: string | null }): string {
  const qs = new URLSearchParams({ ...(f.status ? { status: f.status } : {}), ...(f.period ? { period: f.period } : {}) }).toString();
  return `${REPORTS_LIST_PATH(deptId)}${qs ? `?${qs}` : ""}`;
}

/** What the buttons of a report are, by its state and the server's two flags (BFF §63.18). `reason` is the sentence under a disabled button. */
export interface ReportButtons {
  editable: boolean;
  save: boolean;
  aiDraft: boolean;
  submit: boolean;
  approve: { shown: boolean; allowed: boolean; reason: string | null };
  sendBack: { shown: boolean; allowed: boolean; reason: string | null };
  deliver: { shown: boolean; allowed: boolean; reason: string | null };
}

export function buttonsFor(d: Pick<SocialReportDetail, "status" | "canApprove" | "canDeliver" | "notesComplete">, opts: { dirty?: boolean } = {}): ReportButtons {
  const editable = isEditableState(d.status);
  const inCheck = d.status === "in_review";
  const approveReason = !d.canApprove ? CHECK_SEND_REASON : opts.dirty ? "Save your changes first: the check reads what is saved." : !d.notesComplete ? "Each of the three areas needs an insight and a suggestion before the check can pass." : null;
  return {
    editable, save: editable, aiDraft: editable, submit: d.status === "draft",
    approve: { shown: inCheck, allowed: inCheck && approveReason === null, reason: inCheck ? approveReason : null },
    sendBack: { shown: inCheck, allowed: inCheck && d.canApprove, reason: inCheck && !d.canApprove ? CHECK_SEND_REASON : null },
    deliver: { shown: d.status === "approved", allowed: d.status === "approved" && d.canDeliver, reason: d.status === "approved" && !d.canDeliver ? CHECK_SEND_REASON : null },
  };
}

/** "Delivered 12 Oct 2026" style lines are drawn by the page with `formatDate`; this is the sentence for a list row's state. */
export function rowStateLine(r: Pick<SocialReportRow, "status" | "notesComplete" | "kind">): string {
  if (r.kind === "monthly" && r.status !== "delivered" && r.status !== "approved" && !r.notesComplete) return `${reportStateWords(r.status)} · notes incomplete`;
  return reportStateWords(r.status);
}

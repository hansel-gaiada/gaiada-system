// SCP-5a (BFF §63.18) — the Social Media monthly report: the types of every answer, their defensive parsing, the words for the four states and for every refusal, the form's own
// checks and the pure rules of the two pages. No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialReports-data.ts` (server-only, `ReadResult`), the writes in `lib/socialReportsActions.ts` ("use server"); DEMO_MODE answers every route from
// `lib/demoSocialReports.ts`, in the server's order of checks.
//
// THE FOUR STATES are the design's: Draft (`draft`), HoD check (`in_review`), Ready (`approved`), Sent (`delivered`). WHO DOES WHAT (SCP-Q20): the officer writes, edits and submits;
// the four approvers (the HoD and GM seats, the owner, the superadmin) check (approve, or send back) and send. SCP-5 W5-A4 (BFF §63.24): the same pages serve the six periodic kinds; a daily
// or weekly report is a SHORT kind (a summary and a next-period line, numbers live while a draft), the others keep the monthly's notes and plan. The server's `canApprove` and `canDeliver` on the report read decide which
// buttons are live; the officer's own writes carry no flag, so those buttons are drawn and the server's 403 is said in words. A parsed answer that is the wrong shape throws, and the reader
// turns that into "cannot tell", never into a plausible empty page.
import { isIsoDate } from "./contracts";
import type { ReportDocument } from "./reports";
import { shiftMonth } from "./socialClient";
import { refusalText, REFUSAL_WORDS, type Refusal } from "./socialPipeline";
import { anyPeriodLabel, isKindTab, isShortKind, nextWord, type KindTab } from "./socialReportKinds";

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

/** What each state means for a short kind (daily, weekly): its summary and next-period line, not the three areas. */
export const SHORT_STATE_HELP: Readonly<Record<ReportState, string>> = {
  draft: "The officer is writing it. The numbers are live until it is submitted. Submit it for the HoD check when the summary is ready.",
  in_review: "Waiting for the HoD check. One of the Social Media head, the GM, the owner or the superadmin approves it or sends it back to draft.",
  approved: REPORT_STATE_HELP.approved,
  delivered: REPORT_STATE_HELP.delivered,
};
/** The sentence for a state, by the kind of report. */
export const stateHelp = (kind: string, status: string): string | null => {
  if (!isReportState(status)) return null;
  return (isShortKind(kind) ? SHORT_STATE_HELP : REPORT_STATE_HELP)[status];
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
/** A report's period in words, for every kind ("September 2026", "9 Nov 2026", "Q4 2026"). `fiscalYearStartMonth` only matters for a quarter, half or year of a fiscal year that does not start in January. */
export const periodWords = (period: string | null, kind = "monthly", fiscalYearStartMonth = 1): string => anyPeriodLabel(kind, period, fiscalYearStartMonth);
/** A period in any of the kinds' forms (the list's `period` filter takes them all). */
export const isPeriodShape = (v: unknown): v is string => typeof v === "string" && /^(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4]|\d{4}-H[12]|\d{4})$/.test(v);
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
  /** SCP-5 W5-A4 (BFF §63.24.3): the day it falls due by its kind's own rule (null for a kind with none), whether a summary is written, and whether its numbers are still moving (a draft of a short kind). */
  due?: string | null;
  summaryPresent?: boolean;
  live?: boolean;
}

export function asReportRow(raw: unknown): SocialReportRow {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.status !== "string" || typeof raw.engagementId !== "string") throw new Error("report: not a report row");
  return {
    id: raw.id, engagementId: raw.engagementId, clientName: str(raw.clientName) ?? "A client", period: str(raw.period), kind: str(raw.kind) ?? "monthly", status: raw.status,
    createdAt: str(raw.createdAt), approvedAt: str(raw.approvedAt), deliveredAt: str(raw.deliveredAt), notesComplete: raw.notesComplete === true, simulated: raw.simulated === true,
    due: typeof raw.due === "string" && isIsoDate(raw.due) ? raw.due : null, summaryPresent: raw.summaryPresent === true, live: raw.live === true,
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
  /** SCP-5 W5-A4 (BFF §63.24.3): a short kind's next-period line (null on every other kind, or none written), the day it falls due, and whether the numbers on it are still moving. */
  nextPeriod: string | null;
  due: string | null;
  live: boolean;
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
    canDeliver: raw.canDeliver === true, nextPeriod: typeof raw.nextPeriod === "string" && raw.nextPeriod !== "" ? raw.nextPeriod : null,
    due: typeof raw.due === "string" && isIsoDate(raw.due) ? raw.due : null, live: raw.live === true, document: asDocument(raw.document),
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
  /** A short kind's proposal carries the next-period line (and no notes or plan); a long kind's carries none (null). */
  nextPeriod: string | null;
  /** `ai`: the model's answer was used. `template`: the gateway was down, or its answer failed the number check, and the plain template was used. */
  draftedVia: "ai" | "template";
}

export function asProposal(raw: unknown): ReportProposal {
  if (!isObj(raw) || typeof raw.narrativeMd !== "string" || (!isObj(raw.notes) && !("nextPeriod" in raw))) throw new Error("ai-draft: not a proposal");
  const notes = asNotes(raw.notes);
  return {
    nextPeriod: typeof raw.nextPeriod === "string" ? raw.nextPeriod : null,
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
    case "ai": return "Drafted with AI from the period's numbers and the client's brand notes. Read it, change what you want, and save.";
    case "template": case "fallback": return "The AI could not be used just now (it was down, or its answer stated a number it was not given), so this is the plain template from the period's numbers. Read it, change what you want, and save.";
    case "none": return "AI drafting is turned off for this kind of report, so it starts empty. Write it, then save.";
    case "existing": return "This client already has a report for that period, so it is opened as it is.";
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

// ── A short kind's form (daily, weekly): the summary and the next-period line ────────────────────────────────────────────────

/** The summary's and the next-period line's longest length (BFF §63.24.1; the company's rules may lower the summary's, and the server then says which field). */
export const SHORT_MAX = 1000;
export interface ShortForm { summary: string; nextPeriod: string }

/**
 * A short report's summary as it was SAVED. The report read gives the document, whose narrative carries the next-period line printed under the summary ("Next day: ...", as the client
 * receives it); the form's summary is the text before that line, so a save never writes the printed line into the summary.
 */
export function summaryOf(d: Pick<SocialReportDetail, "kind" | "nextPeriod" | "document">): string {
  const text = d.document.narrative.text;
  const next = d.nextPeriod?.trim();
  if (!isShortKind(d.kind) || !next) return text;
  const tail = `\n\nNext ${nextWord(d.kind)}: ${next}`;
  return text.endsWith(tail) ? text.slice(0, -tail.length) : text;
}
export const shortFormFromDetail = (d: Pick<SocialReportDetail, "kind" | "nextPeriod" | "document">): ShortForm => ({ summary: summaryOf(d), nextPeriod: d.nextPeriod ?? "" });
/** A short proposal laid over the form: it fills the fields and saves nothing. */
export const shortFormFromProposal = (p: ReportProposal): ShortForm => ({ summary: p.narrativeMd, nextPeriod: p.nextPeriod ?? "" });
export const sameShortForm = (a: ShortForm, b: ShortForm): boolean => a.summary === b.summary && a.nextPeriod === b.nextPeriod;

export type ShortCheck = { ok: true; body: { narrativeMd: string; nextPeriod: string | null } } | { ok: false; field: string; message: string };
/** The server's own limits, checked before the request: at most 1,000 characters each. A blank next-period line is sent as null, which clears it. */
export function buildShortBody(f: ShortForm, max = SHORT_MAX): ShortCheck {
  if (f.summary.length > max) return { ok: false, field: "narrativeMd", message: `The summary is over ${max} characters.` };
  if (f.nextPeriod.length > SHORT_MAX) return { ok: false, field: "nextPeriod", message: `The next-period line is over ${SHORT_MAX} characters.` };
  return { ok: true, body: { narrativeMd: f.summary, nextPeriod: hasText(f.nextPeriod) ? f.nextPeriod : null } };
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
  invalid_kind: "A report is a daily, weekly, monthly, quarterly, half-year, yearly, campaign or ad hoc report.",
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
  summary_missing: "The HoD check cannot pass yet: the report has no summary. Send it back to draft, write the summary and submit it again.",
  summary_numbers_changed: "The summary states a number that the report's numbers no longer hold, because they moved after it was written. Read the numbers again, correct the summary and submit it again.",
  period_not_over: "That period is not over yet, so its numbers are not final. Pick a period that has ended.",
  action_plan_missing: "The HoD check cannot pass yet: the report has no action plan. Send it back to draft, add the actions and submit it again.",
  next_period_missing: "The HoD check cannot pass yet: the report has no line about what comes next. Send it back to draft, write it and submit it again.",
  report_kind_off: "Your company has turned this kind of report off. The Social Media head can turn it on in Settings.",
  ai_drafting_off: "AI drafting is turned off for this kind of report, so it is written by hand.",
  generation_running: "A run for this kind of report and period is already going. Wait for it to finish.",
  run_not_found: "That run was not found. It may belong to someone else, or be too old to list.",
  id_invalid: "That is not a report.",
  engagement_id_invalid: "That is not a client.",
  session_expired: "Session expired — sign in again.",
  no_company: "Choose a company first.",
};

const FIELD_WORDS: Readonly<Record<string, string>> = {
  notes: `The notes are not valid. Each area has an insight and a suggestion of at most ${NOTE_MAX} characters.`,
  actionPlan: `The action plan is not valid. It has at most ${ACTION_PLAN_MAX} actions, each of 1 to ${ACTION_MAX} characters, owned by the agency or the client, with a real due date or none.`,
  narrativeMd: `The narrative or summary is not valid. A short report's summary is at most ${SHORT_MAX} characters.`,
  nextPeriod: `The next-period line is not valid. It is at most ${SHORT_MAX} characters, and only a daily or weekly report has one.`,
  kind: "That kind of report is not known.",
  status: "The status filter is not valid.",
  period: "The period is not valid for this kind of report. Use a real day, week, month, quarter, half or year, and not one that has not begun.",
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
  if (r.error === "summary_numbers_changed") {
    const numbers = Array.isArray(r.detail?.numbers) ? (r.detail.numbers as unknown[]).filter((n): n is string | number => typeof n === "string" || typeof n === "number") : [];
    return numbers.length > 0 ? `${REPORT_REFUSAL_WORDS.summary_numbers_changed} The numbers it states that moved: ${numbers.join(", ")}.` : REPORT_REFUSAL_WORDS.summary_numbers_changed;
  }
  return REPORT_REFUSAL_WORDS[r.error] ?? REFUSAL_WORDS[r.error] ?? refusalText(r);
}

// ── The pages' rules ──────────────────────────────────────────────────────────────────────────────

export const REPORTS_LIST_PATH = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/social-reports`;
export const reportHref = (deptId: string, reportId: string): string => `${REPORTS_LIST_PATH(deptId)}/${encodeURIComponent(reportId)}`;

/** The list's filters, from the page's query (`status` and `period`): a value that is not one is ignored, so a mistyped link shows the whole list. */
export function parseReportFilters(q: { status?: string | string[]; period?: string | string[]; kind?: string | string[] }): { status: ReportState | null; period: string | null; kind: KindTab | null } {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : v?.[0]);
  const s = one(q.status);
  const p = one(q.period);
  const k = one(q.kind);
  return { status: isReportState(s) ? s : null, period: isPeriodShape(p) ? p : null, kind: isKindTab(k) ? k : null };
}

export function filtersHref(deptId: string, f: { status: string | null; period: string | null; kind?: string | null }): string {
  const qs = new URLSearchParams({ ...(f.kind ? { kind: f.kind } : {}), ...(f.status ? { status: f.status } : {}), ...(f.period ? { period: f.period } : {}) }).toString();
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

export function buttonsFor(
  d: Pick<SocialReportDetail, "status" | "canApprove" | "canDeliver" | "notesComplete"> & { kind?: string },
  opts: { dirty?: boolean; summaryPresent?: boolean } = {},
): ReportButtons {
  const editable = isEditableState(d.status);
  const inCheck = d.status === "in_review";
  // A short kind's check needs its summary (the notes are not a part of it); every other kind's needs what `notesComplete` says.
  const short = d.kind !== undefined && isShortKind(d.kind);
  const approveReason = !d.canApprove ? CHECK_SEND_REASON
    : opts.dirty ? "Save your changes first: the check reads what is saved."
    : short ? (opts.summaryPresent === false ? "The summary needs to be written before the check can pass." : null)
    : !d.notesComplete ? "Each of the three areas needs an insight and a suggestion before the check can pass." : null;
  return {
    editable, save: editable, aiDraft: editable, submit: d.status === "draft",
    approve: { shown: inCheck, allowed: inCheck && approveReason === null, reason: inCheck ? approveReason : null },
    sendBack: { shown: inCheck, allowed: inCheck && d.canApprove, reason: inCheck && !d.canApprove ? CHECK_SEND_REASON : null },
    deliver: { shown: d.status === "approved", allowed: d.status === "approved" && d.canDeliver, reason: d.status === "approved" && !d.canDeliver ? CHECK_SEND_REASON : null },
  };
}

/** The kinds whose report carries the three areas and the action plan, and whose HoD check needs the notes. */
export const NOTES_KINDS: readonly string[] = ["monthly", "quarterly", "semester", "yearly"];

/** "Delivered 12 Oct 2026" style lines are drawn by the page with `formatDate`; this is the sentence for a list row's state. */
export function rowStateLine(r: Pick<SocialReportRow, "status" | "notesComplete" | "kind"> & { summaryPresent?: boolean }): string {
  const open = r.status === "draft" || r.status === "in_review";
  if (NOTES_KINDS.includes(r.kind) && open && !r.notesComplete) return `${reportStateWords(r.status)} · notes incomplete`;
  if (isShortKind(r.kind) && open && r.summaryPresent === false) return `${reportStateWords(r.status)} · no summary`;
  return reportStateWords(r.status);
}

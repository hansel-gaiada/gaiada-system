// SCP-5 W5-A4 (BFF §63.25) — "Ideas for next month" on the monthly report's page: the types of the ideas read, their defensive parsing, the three states in words, the form's own checks, the cycle
// picker's rule and the words for each refusal. Pure and client-safe: no I/O, no clock (the caller passes `today`).
//
// An idea is what the team saw, the metric it rests on and what it suggests. Its state is `proposed`, `shared` (the team shared it with the client) or `planned` (turned into a planned post of a
// cycle, linked both ways). WHO: the client's officer and the four approvers write ideas; the server says so in the list's `canWrite`, and every write is refused 403 for anyone else. A planned idea
// cannot change or be deleted (409 `idea_planned`): discarding its post frees it. A parsed answer that is the wrong shape throws, and the page says it cannot tell, never an empty list.
import { REFUSAL_WORDS, refusalText, type Refusal } from "./socialPipeline";
import { REPORT_REFUSAL_WORDS } from "./socialReports";
import { shiftMonth } from "./socialClient";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export const IDEA_STATUSES = ["proposed", "shared", "planned"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
/** The design's three words. */
export const IDEA_STATUS_WORDS: Readonly<Record<IdeaStatus, string>> = { proposed: "Proposed", shared: "Shared with client", planned: "Added to plan" };
export const ideaStatusWords = (s: string): string => IDEA_STATUS_WORDS[s as IdeaStatus] ?? s;

export const SAW_MAX = 500;
export const METRIC_MAX = 300;
export const SUGGESTION_MAX = 500;

export interface Idea {
  id: string;
  engagementId: string;
  saw: string;
  metric: string | null;
  suggestion: string;
  status: string;
  reportId: string | null;
  post: { id: string; title: string; pipelineStatus: string | null; cycleMonth: string | null } | null;
  sharedAt: string | null;
  sharedBy: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string | null;
}

const person = (v: unknown): { id: string; name: string } | null => (isObj(v) && typeof v.id === "string" ? { id: v.id, name: str(v.name) ?? "" } : null);

export function asIdea(raw: unknown): Idea {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.status !== "string" || typeof raw.saw !== "string" || typeof raw.suggestion !== "string") throw new Error("idea: not an idea");
  const p = isObj(raw.post) && typeof raw.post.id === "string" ? raw.post : null;
  return {
    id: raw.id, engagementId: str(raw.engagementId) ?? "", saw: raw.saw, metric: str(raw.metric), suggestion: raw.suggestion, status: raw.status, reportId: str(raw.reportId),
    post: p ? { id: p.id as string, title: str(p.title) ?? "", pipelineStatus: str(p.pipelineStatus), cycleMonth: str(p.cycleMonth) } : null,
    sharedAt: str(raw.sharedAt), sharedBy: person(raw.sharedBy), createdBy: person(raw.createdBy), createdAt: str(raw.createdAt),
  };
}

/** `GET engagements/:engagementId/ideas`: `{items, canWrite}`, newest first. `canWrite` is the server's answer to "may this person write ideas for this client". */
export function asIdeaList(raw: unknown): { items: Idea[]; canWrite: boolean } {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("ideas: not a list of ideas");
  return { items: raw.items.map(asIdea), canWrite: raw.canWrite === true };
}

/** An idea's answer to a write (`{idea}`), parsed. */
export function asIdeaAnswer(raw: unknown): Idea {
  if (!isObj(raw)) throw new Error("idea: not an answer");
  return asIdea(raw.idea);
}

// ── What a person may do with an idea ──────────────────────────────────────────────────────────────────────────────────────

export interface IdeaActions {
  /** Add to next plan: a `proposed` or `shared` idea. */
  plan: boolean;
  /** Mark shared: a `proposed` idea. */
  share: boolean;
  /** Delete: a `proposed` or `shared` idea. */
  remove: boolean;
}

/**
 * The actions drawn on an idea: only those the state allows AND the read's `canWrite` says the viewer may take. Where the read says the viewer may not write, none is drawn (the page says why once,
 * under the section), so no button is offered only to be refused.
 */
export function actionsFor(idea: Pick<Idea, "status">, canWrite: boolean): IdeaActions {
  const open = idea.status === "proposed" || idea.status === "shared";
  return { plan: canWrite && open, share: canWrite && idea.status === "proposed", remove: canWrite && open };
}

export const IDEA_WRITE_REASON = "Only this client's officer, the Social Media head, the GM, the owner and the superadmin can add or change ideas.";

// ── The add form ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface IdeaForm { saw: string; metric: string; suggestion: string }
export const emptyIdeaForm = (): IdeaForm => ({ saw: "", metric: "", suggestion: "" });

const charLen = (s: string): number => [...s].length;
export type IdeaCheck = { ok: true; body: { saw: string; metric: string | null; suggestion: string; reportId?: string } } | { ok: false; field: keyof IdeaForm; message: string };

/**
 * The server's own checks, before the request: `saw` and `suggestion` are required, 1 to 500 characters once trimmed; the metric is 1 to 300 and, by the company's rule
 * (`ideas.metricRequired`), required. An idea added from a report carries the report's id.
 */
export function buildIdeaBody(f: IdeaForm, o: { metricRequired: boolean; reportId?: string | null }): IdeaCheck {
  const saw = f.saw.trim();
  const metric = f.metric.trim();
  const suggestion = f.suggestion.trim();
  if (saw === "") return { ok: false, field: "saw", message: "Write what we saw." };
  if (charLen(saw) > SAW_MAX) return { ok: false, field: "saw", message: `What we saw is over ${SAW_MAX} characters.` };
  if (metric === "" && o.metricRequired) return { ok: false, field: "metric", message: "Name the metric this rests on." };
  if (charLen(metric) > METRIC_MAX) return { ok: false, field: "metric", message: `The metric is over ${METRIC_MAX} characters.` };
  if (suggestion === "") return { ok: false, field: "suggestion", message: "Write what we suggest." };
  if (charLen(suggestion) > SUGGESTION_MAX) return { ok: false, field: "suggestion", message: `What we suggest is over ${SUGGESTION_MAX} characters.` };
  return { ok: true, body: { saw, metric: metric === "" ? null : metric, suggestion, ...(o.reportId ? { reportId: o.reportId } : {}) } };
}

// ── The cycle picker ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How many months after the report month the picker looks at: the next open cycle and the two after it. */
export const PLAN_MONTHS_AHEAD = 3;

/**
 * The months whose cycles "Add to next plan" may be offered: after the report's month (the next plan) and not before this month (the server's 409 `cycle_closed` is a month before today's), the
 * report month's next `PLAN_MONTHS_AHEAD` months. `reportPeriod` is `YYYY-MM`, `today` an ISO day. The cycles themselves are the client's own rows (`GET cycles?month=`).
 */
export function planMonths(reportPeriod: string, today: string): string[] {
  const thisMonth = today.slice(0, 7);
  const out: string[] = [];
  for (let i = 1; i <= PLAN_MONTHS_AHEAD; i++) {
    const m = shiftMonth(reportPeriod, i);
    if (m >= thisMonth) out.push(m);
  }
  // A report so old that every month near it is closed still offers this month and the next, which are after it and open, never an empty picker for that reason alone.
  if (out.length === 0) for (let i = 0; i < 2; i++) out.push(shiftMonth(thisMonth, i));
  return out;
}

export interface CycleChoice { cycleId: string; month: string }

/** The `cycleId` of `engagementId` in a month's deadline table (`CycleTable.rows`), or null when the client has no cycle that month. */
export function cycleChoiceOf(rows: ReadonlyArray<{ engagementId: string; cycleId: string | null }>, engagementId: string, month: string): CycleChoice | null {
  const r = rows.find((x) => x.engagementId === engagementId);
  return r?.cycleId ? { cycleId: r.cycleId, month } : null;
}

// ── The refusals ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type IdeaWriteKind = "add" | "share" | "plan" | "delete";

const FIELD_WORDS: Readonly<Record<string, string>> = {
  saw: `What we saw is required, up to ${SAW_MAX} characters.`,
  metric: `The metric is required by your company's rules, up to ${METRIC_MAX} characters.`,
  suggestion: `What we suggest is required, up to ${SUGGESTION_MAX} characters.`,
  cycleId: "Pick the plan month first.",
  reportId: "An idea can only be raised with a monthly report of the same client.",
  id: "That idea id is already used for another client.",
};

/** A refusal of an ideas write in a sentence. A 403 says who may; every other code has its own words (`idea_planned`, `cycle_closed`, `idea_not_found`, ...); the code stays the contract. */
export function ideaRefusalText(r: Refusal, kind: IdeaWriteKind = "add"): string {
  if (r.status === 403 && r.error !== "automation_cannot_act" && r.reason !== "assurance_required") return `You cannot do this. ${IDEA_WRITE_REASON}`;
  if (r.error === "invalid_field" || r.error === "missing_field") return (r.field && FIELD_WORDS[r.field]) || refusalText(r);
  if (r.status === 404 && r.error === "engagement_not_found") return "That client was not found, or is not yours to see.";
  if (r.status === 404 && kind === "plan" && r.error === "cycle_not_found") return "That client has no plan for that month. Set its deadlines first.";
  return REFUSAL_WORDS[r.error] ?? REPORT_REFUSAL_WORDS[r.error] ?? refusalText(r);
}

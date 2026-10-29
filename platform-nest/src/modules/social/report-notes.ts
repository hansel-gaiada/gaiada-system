// SCP-5a (docs/FRONTEND-BFF-CONTRACT.md §63.1 file 9, §63.18) — the monthly report's notes and action plan: their shapes, the
// route's validation (400 `{field: 'notes'}` / `{field: 'actionPlan'}`), the HoD check's completeness rule (400
// `notes_incomplete`), and "Draft with AI": the prompt, the parse and the plain template it falls back to.
//
// PURE: no I/O. social-reports.controller.ts reads the rows, calls the gateway and writes; this file only decides.
//
// ── THE SHAPES (63.1 file 9) ──────────────────────────────────────────────────────────────────────────────────────────
//   notes        {followers?, engagement?, audience?}, each {insight: string <= 500, suggestion: string <= 500}.
//   action_plan  at most 10 {action: 1..300, owner: 'agency'|'client', due?: 'YYYY-MM-DD'}.
// The columns only refuse a non-object / non-array; every other rule is here, so an old row (`{}`, `[]`) reads as "nothing
// written yet", never as an error.
//
// ── "DRAFT WITH AI": ONE DRAFT, ONE SOURCE ────────────────────────────────────────────────────────────────────────────
// The model answers the narrative, the three notes and the action plan in one JSON object. The proposal is the model's only
// when EVERY part passes (the narrative's numeric guard, the notes' shapes, completeness and numeric guard, the plan's
// shapes); otherwise the whole proposal is the plain template and says so (`draftedVia: 'template'`). A half-AI, half-template
// proposal labelled either way would misdescribe itself, and the officer reads `draftedVia` to know what they are editing.
//
// The numeric guard (ai-drafts.ts `findUngroundedNumbers`, deliberately strict) runs on the narrative and on every INSIGHT: an
// insight is a claim about the numbers, so it may state only a number the snapshot gave. Suggestions and actions are advice
// ("two more reels a week") and are not claims about what happened, so they are not held to it.
import {
  findUngroundedNumbers, parseReportNarrativeDraft, reportGroundingLines, type ReportNarrativeGroundingFacts,
} from "./ai-drafts";

export const NOTE_AREAS = ["followers", "engagement", "audience"] as const;
export type NoteArea = (typeof NOTE_AREAS)[number];
export const NOTE_MAX = 500;
export const ACTION_MAX = 300;
export const ACTION_PLAN_MAX = 10;
export const ACTION_OWNERS = ["agency", "client"] as const;
export type ActionOwner = (typeof ACTION_OWNERS)[number];

export interface ReportNote { insight: string; suggestion: string }
export type ReportNotes = Partial<Record<NoteArea, ReportNote>>;
export interface ReportAction { action: string; owner: ActionOwner; due?: string }

export type Validated<T> = { ok: true; value: T } | { ok: false };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasText = (s: unknown): boolean => typeof s === "string" && /\S/.test(s);

/** A real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * The body's `notes`, or `{ok: false}` (the route answers 400 `{field: 'notes'}`). An object whose keys are among the three
 * areas, each an object whose keys are among `insight` and `suggestion`, each a string of at most 500 characters. A missing
 * insight or suggestion is stored as "" (written later; `notesComplete` decides whether the check may pass).
 */
export function validateNotes(v: unknown): Validated<ReportNotes> {
  if (!isPlainObject(v)) return { ok: false };
  const out: ReportNotes = {};
  for (const [key, area] of Object.entries(v)) {
    if (!(NOTE_AREAS as readonly string[]).includes(key) || !isPlainObject(area)) return { ok: false };
    for (const k of Object.keys(area)) if (k !== "insight" && k !== "suggestion") return { ok: false };
    // Absent is "not written yet"; null or any other non-string is a bad shape.
    const insight = area.insight === undefined ? "" : area.insight;
    const suggestion = area.suggestion === undefined ? "" : area.suggestion;
    if (typeof insight !== "string" || typeof suggestion !== "string") return { ok: false };
    if (insight.length > NOTE_MAX || suggestion.length > NOTE_MAX) return { ok: false };
    out[key as NoteArea] = { insight, suggestion };
  }
  return { ok: true, value: out };
}

/**
 * The body's `actionPlan`, or `{ok: false}` (400 `{field: 'actionPlan'}`). At most 10 objects with `action` (1 to 300
 * characters, not blank), `owner` ('agency' | 'client') and an optional `due` (a real date, `YYYY-MM-DD`; null or absent means
 * none). No other key.
 */
export function validateActionPlan(v: unknown): Validated<ReportAction[]> {
  if (!Array.isArray(v) || v.length > ACTION_PLAN_MAX) return { ok: false };
  const out: ReportAction[] = [];
  for (const item of v) {
    if (!isPlainObject(item)) return { ok: false };
    for (const k of Object.keys(item)) if (k !== "action" && k !== "owner" && k !== "due") return { ok: false };
    const { action, owner, due } = item;
    if (typeof action !== "string" || !hasText(action) || action.length > ACTION_MAX) return { ok: false };
    if (typeof owner !== "string" || !(ACTION_OWNERS as readonly string[]).includes(owner)) return { ok: false };
    if (due !== undefined && due !== null && !isIsoDate(due)) return { ok: false };
    out.push({ action, owner: owner as ActionOwner, ...(typeof due === "string" ? { due } : {}) });
  }
  return { ok: true, value: out };
}

/** Every area has an insight and a suggestion that are not blank: the HoD check may pass (else 400 `notes_incomplete`). */
export function notesComplete(notes: unknown): boolean {
  if (!isPlainObject(notes)) return false;
  return NOTE_AREAS.every((a) => {
    const n = notes[a];
    return isPlainObject(n) && hasText(n.insight) && hasText(n.suggestion);
  });
}

/** A stored `notes` value read back leniently (an unexpected shape reads as no notes, never a throw). */
export function readStoredNotes(v: unknown): ReportNotes {
  const r = validateNotes(v);
  return r.ok ? r.value : {};
}

/** A stored `action_plan` read back leniently. */
export function readStoredActionPlan(v: unknown): ReportAction[] {
  const r = validateActionPlan(v);
  return r.ok ? r.value : [];
}

// ── "Draft with AI" ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface MonthlyReportDraft {
  narrativeMd: string;
  notes: Required<ReportNotes>;
  actionPlan: ReportAction[];
  draftedVia: "ai" | "template";
  /** Why the model's answer was not used, when it was not (for the activity log; never shown to the client). */
  rejected?: { part: "narrative" | "notes" | "actionPlan"; numbers?: string[] };
}

const kpiOf = (facts: ReportNarrativeGroundingFacts, label: string) => facts.kpis.find((k) => k.label === label) ?? null;

/** The plain template: states only the snapshot's own numbers, verbatim, and says plainly what was not fetched. */
export function templateNotes(facts: ReportNarrativeGroundingFacts): Required<ReportNotes> {
  const followers = kpiOf(facts, "Followers");
  const rate = kpiOf(facts, "Engagement rate");
  const engagements = kpiOf(facts, "Engagements");
  const reach = kpiOf(facts, "Reach");
  const impressions = kpiOf(facts, "Impressions");
  return {
    followers: {
      insight: followers
        ? `Followers stood at ${followers.value} at the end of ${facts.periodLabel}.`
        : `Follower counts have not been fetched for ${facts.periodLabel} yet.`,
      suggestion: "Keep to the agreed posting schedule and note which formats bring in new followers.",
    },
    engagement: {
      insight: rate
        ? `The engagement rate was ${rate.value}% for ${facts.periodLabel}.`
        : engagements
          ? `Posts drew ${engagements.value} engagements in ${facts.periodLabel}.`
          : `Engagement has not been fetched for ${facts.periodLabel} yet.`,
      suggestion: "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
    },
    audience: {
      insight: reach
        ? `Posts reached ${reach.value} accounts in ${facts.periodLabel}.`
        : impressions
          ? `Posts were seen ${impressions.value} times in ${facts.periodLabel}.`
          : `Reach has not been fetched for ${facts.periodLabel} yet.`,
      suggestion: "Review the posting times against when the audience is most active.",
    },
  };
}

export function templateActionPlan(): ReportAction[] {
  return [
    { action: "Review the month's best-performing posts and plan more in the same formats.", owner: "agency" },
    { action: "Confirm next month's priorities, promotions and key dates.", owner: "client" },
  ];
}

/** The prompt: the narrative's grounding (the snapshot's numbers only, the top posts, the client's own brand corpus), then the
 *  three notes and the action plan, answered as one strict JSON object. */
export function buildMonthlyReportDraftPrompt(facts: ReportNarrativeGroundingFacts): string {
  return [
    ...reportGroundingLines(facts),
    "Write three things in this brand's voice:\n"
      + "1. narrative: 2-4 short paragraphs summarizing performance for the period.\n"
      + "2. notes: for each of the areas followers, engagement and audience, one insight (what the numbers show, at most "
      + `${NOTE_MAX} characters) and one suggestion (what to do about it, at most ${NOTE_MAX} characters).\n`
      + `3. actionPlan: 2 to 5 concrete next steps (each at most ${ACTION_MAX} characters), each owned by "agency" or "client".`,
    "NEVER state a number you were not given above, and never imply a metric was zero just because it was not mentioned: say "
      + "it has not been fetched yet instead. Never suggest generating or attaching an image: this system has no "
      + "image-generation capability.",
    'Reply with STRICT JSON only, no prose, no markdown fences: {"narrative": "...", "notes": {"followers": {"insight": "...", '
      + '"suggestion": "..."}, "engagement": {"insight": "...", "suggestion": "..."}, "audience": {"insight": "...", '
      + '"suggestion": "..."}}, "actionPlan": [{"action": "...", "owner": "agency"}]}',
  ].join("\n\n");
}

function template(facts: ReportNarrativeGroundingFacts, rejected?: MonthlyReportDraft["rejected"]): MonthlyReportDraft {
  return {
    narrativeMd: parseReportNarrativeDraft(null, facts).text,
    notes: templateNotes(facts),
    actionPlan: templateActionPlan(),
    draftedVia: "template",
    ...(rejected ? { rejected } : {}),
  };
}

/** Parse the gateway's answer into a proposal. NEVER throws; any part that fails makes the whole proposal the template. */
export function parseMonthlyReportDraft(raw: string | null, facts: ReportNarrativeGroundingFacts): MonthlyReportDraft {
  if (!raw) return template(facts);
  const narrative = parseReportNarrativeDraft(raw, facts);
  if (narrative.draftedVia !== "ai") {
    return template(facts, narrative.rejectedNumbers ? { part: "narrative", numbers: narrative.rejectedNumbers } : undefined);
  }
  let parsed: { notes?: unknown; actionPlan?: unknown };
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)![0]) as typeof parsed;
  } catch {
    return template(facts);
  }
  const notes = validateNotes(parsed.notes);
  if (!notes.ok || !notesComplete(notes.value)) return template(facts, { part: "notes" });
  const ungrounded = NOTE_AREAS.flatMap((a) => findUngroundedNumbers(notes.value[a]!.insight, facts));
  if (ungrounded.length > 0) return template(facts, { part: "notes", numbers: [...new Set(ungrounded)] });
  const plan = validateActionPlan(parsed.actionPlan);
  if (!plan.ok || plan.value.length === 0) return template(facts, { part: "actionPlan" });
  return {
    narrativeMd: narrative.text,
    notes: { followers: notes.value.followers!, engagement: notes.value.engagement!, audience: notes.value.audience! },
    actionPlan: plan.value,
    draftedVia: "ai",
  };
}

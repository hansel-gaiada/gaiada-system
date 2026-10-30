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
/** The three areas by default; a company's rules (BFF §63.30, `content.notes.areas`) may name others, so the keys are strings. */
export type ReportNotes = Partial<Record<string, ReportNote>>;
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
export function validateNotes(v: unknown, areaKeys: readonly string[] = NOTE_AREAS): Validated<ReportNotes> {
  if (!isPlainObject(v)) return { ok: false };
  const out: ReportNotes = {};
  for (const [key, area] of Object.entries(v)) {
    if (!areaKeys.includes(key) || !isPlainObject(area)) return { ok: false };
    for (const k of Object.keys(area)) if (k !== "insight" && k !== "suggestion") return { ok: false };
    // Absent is "not written yet"; null or any other non-string is a bad shape.
    const insight = area.insight === undefined ? "" : area.insight;
    const suggestion = area.suggestion === undefined ? "" : area.suggestion;
    if (typeof insight !== "string" || typeof suggestion !== "string") return { ok: false };
    if (insight.length > NOTE_MAX || suggestion.length > NOTE_MAX) return { ok: false };
    out[key] = { insight, suggestion };
  }
  return { ok: true, value: out };
}

/**
 * The body's `actionPlan`, or `{ok: false}` (400 `{field: 'actionPlan'}`). At most 10 objects with `action` (1 to 300
 * characters, not blank), `owner` ('agency' | 'client') and an optional `due` (a real date, `YYYY-MM-DD`; null or absent means
 * none). No other key.
 */
export function validateActionPlan(v: unknown, max: number = ACTION_PLAN_MAX): Validated<ReportAction[]> {
  if (!Array.isArray(v) || v.length > max) return { ok: false };
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
export function notesComplete(notes: unknown, areaKeys: readonly string[] = NOTE_AREAS): boolean {
  if (!isPlainObject(notes)) return false;
  return areaKeys.every((a) => {
    const n = notes[a];
    return isPlainObject(n) && hasText(n.insight) && hasText(n.suggestion);
  });
}

/** A stored `notes` value read back leniently (an unexpected shape reads as no notes, never a throw). Whatever areas it holds are
 *  read: the report's own rules named them when it was written (W5-A2). */
export function readStoredNotes(v: unknown): ReportNotes {
  if (!isPlainObject(v)) return {};
  const r = validateNotes(v, Object.keys(v));
  return r.ok ? r.value : {};
}

/** The most actions any company's rules allow (BFF §63.30.1: 1 to 20). */
export const ACTION_PLAN_HARD_MAX = 20;

/** A stored `action_plan` read back leniently (up to the most any company's rules allow: the report's own rules checked it on write). */
export function readStoredActionPlan(v: unknown): ReportAction[] {
  const r = validateActionPlan(v, ACTION_PLAN_HARD_MAX);
  return r.ok ? r.value : [];
}

// ── "Draft with AI" ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What a long-kind draft holds, from the report's own rules (BFF §63.30.1): the notes' areas, the action plan and the narrative's limit. */
export interface DraftShape {
  areas: ReadonlyArray<{ key: string; label: string }>;
  actionPlan: { enabled: boolean; max: number };
  narrativeMax: number | null;
}

/** The monthly report as SCP-5a built it: three areas, an action plan of at most ten, no limit on the narrative. */
export const MONTHLY_SHAPE: DraftShape = {
  areas: [{ key: "followers", label: "Followers" }, { key: "engagement", label: "Engagement" }, { key: "audience", label: "Audience" }],
  actionPlan: { enabled: true, max: ACTION_PLAN_MAX },
  narrativeMax: null,
};

export interface MonthlyReportDraft {
  narrativeMd: string;
  /** Every area of the report's shape (the three by default; none when its rules name none). */
  notes: Record<string, ReportNote>;
  actionPlan: ReportAction[];
  draftedVia: "ai" | "template";
  /** Why the model's answer was not used, when it was not (for the activity log; never shown to the client). */
  rejected?: { part: "narrative" | "notes" | "actionPlan"; numbers?: string[] };
}

const kpiOf = (facts: ReportNarrativeGroundingFacts, label: string) => facts.kpis.find((k) => k.label === label) ?? null;

/** `text` cut at the last whitespace within `max` characters (never inside a word or a number), or whole when it fits or `max` is null. */
export function fitToMax(text: string, max: number | null): string {
  if (max === null || text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.search(/\s\S*$/);
  return (at > 0 ? cut.slice(0, at) : cut).trimEnd();
}

/** The plain template: states only the snapshot's own numbers, verbatim, and says plainly what was not fetched. */
export function templateNotes(
  facts: ReportNarrativeGroundingFacts, areas: ReadonlyArray<{ key: string; label: string }> = MONTHLY_SHAPE.areas,
): Record<string, ReportNote> {
  const followers = kpiOf(facts, "Followers");
  const rate = kpiOf(facts, "Engagement rate");
  const engagements = kpiOf(facts, "Engagements");
  const reach = kpiOf(facts, "Reach");
  const impressions = kpiOf(facts, "Impressions");
  const known: Record<string, ReportNote> = {
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
  // An area a company added has no figure of its own to state: the template says so and leaves the reading to the team.
  const out: Record<string, ReportNote> = {};
  for (const a of areas) {
    out[a.key] = known[a.key] ?? {
      insight: `${a.label} has no figures of its own for ${facts.periodLabel}: add the team's reading.`,
      suggestion: `Add what the team recommends for ${a.label.toLowerCase()}.`,
    };
  }
  return out;
}

export function templateActionPlan(max: number = ACTION_PLAN_MAX): ReportAction[] {
  const plan: ReportAction[] = [
    { action: "Review the month's best-performing posts and plan more in the same formats.", owner: "agency" },
    { action: "Confirm next month's priorities, promotions and key dates.", owner: "client" },
  ];
  return plan.slice(0, Math.max(0, max));
}

/** "a", "a and b", "a, b and c". */
function listPhrase(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The prompt: the narrative's grounding (the snapshot's numbers only, the top posts, the client's own brand corpus), then the
 *  notes and the action plan the report's rules ask for (by default the three notes and the plan), answered as one strict JSON object. */
export function buildMonthlyReportDraftPrompt(facts: ReportNarrativeGroundingFacts, shape: DraftShape = MONTHLY_SHAPE): string {
  const items: string[] = [
    `narrative: 2-4 short paragraphs summarizing performance for the period${shape.narrativeMax === null ? "" : ` (at most ${shape.narrativeMax} characters in all)`}.`,
  ];
  const json: string[] = ['"narrative": "..."'];
  if (shape.areas.length > 0) {
    const names = shape.areas.map((a) => (a.label.toLowerCase() === a.key ? a.key : `${a.key} (${a.label})`));
    items.push(
      `notes: for each of the areas ${listPhrase(names)}, one insight (what the numbers show, at most `
      + `${NOTE_MAX} characters) and one suggestion (what to do about it, at most ${NOTE_MAX} characters).`,
    );
    json.push(`"notes": {${shape.areas.map((a) => `"${a.key}": {"insight": "...", "suggestion": "..."}`).join(", ")}}`);
  }
  if (shape.actionPlan.enabled) {
    const top = Math.min(5, shape.actionPlan.max);
    items.push(`actionPlan: ${Math.min(2, top)} to ${top} concrete next steps (each at most ${ACTION_MAX} characters), each owned by "agency" or "client".`);
    json.push('"actionPlan": [{"action": "...", "owner": "agency"}]');
  }
  const count = ["", "one thing", "two things", "three things"][items.length];
  return [
    ...reportGroundingLines(facts),
    `Write ${count} in this brand's voice:\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    "NEVER state a number you were not given above, and never imply a metric was zero just because it was not mentioned: say "
      + "it has not been fetched yet instead. Never suggest generating or attaching an image: this system has no "
      + "image-generation capability.",
    `Reply with STRICT JSON only, no prose, no markdown fences: {${json.join(", ")}}`,
  ].join("\n\n");
}

function template(facts: ReportNarrativeGroundingFacts, shape: DraftShape, rejected?: MonthlyReportDraft["rejected"]): MonthlyReportDraft {
  return {
    narrativeMd: fitToMax(parseReportNarrativeDraft(null, facts).text, shape.narrativeMax),
    notes: shape.areas.length > 0 ? templateNotes(facts, shape.areas) : {},
    actionPlan: shape.actionPlan.enabled ? templateActionPlan(shape.actionPlan.max) : [],
    draftedVia: "template",
    ...(rejected ? { rejected } : {}),
  };
}

/** Parse the gateway's answer into a proposal. NEVER throws; any part that fails makes the whole proposal the template. */
export function parseMonthlyReportDraft(raw: string | null, facts: ReportNarrativeGroundingFacts, shape: DraftShape = MONTHLY_SHAPE): MonthlyReportDraft {
  if (!raw) return template(facts, shape);
  const narrative = parseReportNarrativeDraft(raw, facts);
  if (narrative.draftedVia !== "ai") {
    return template(facts, shape, narrative.rejectedNumbers ? { part: "narrative", numbers: narrative.rejectedNumbers } : undefined);
  }
  if (shape.narrativeMax !== null && narrative.text.length > shape.narrativeMax) return template(facts, shape, { part: "narrative" });
  let parsed: { notes?: unknown; actionPlan?: unknown };
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)![0]) as typeof parsed;
  } catch {
    return template(facts, shape);
  }
  const keys = shape.areas.map((a) => a.key);
  let notes: Record<string, ReportNote> = {};
  if (keys.length > 0) {
    const v = validateNotes(parsed.notes, keys);
    if (!v.ok || !notesComplete(v.value, keys)) return template(facts, shape, { part: "notes" });
    const ungrounded = keys.flatMap((a) => findUngroundedNumbers(v.value[a]!.insight, facts));
    if (ungrounded.length > 0) return template(facts, shape, { part: "notes", numbers: [...new Set(ungrounded)] });
    notes = Object.fromEntries(keys.map((a) => [a, v.value[a]!]));
  }
  let actionPlan: ReportAction[] = [];
  if (shape.actionPlan.enabled) {
    const plan = validateActionPlan(parsed.actionPlan, shape.actionPlan.max);
    if (!plan.ok || plan.value.length === 0) return template(facts, shape, { part: "actionPlan" });
    actionPlan = plan.value;
  }
  return { narrativeMd: narrative.text, notes, actionPlan, draftedVia: "ai" };
}

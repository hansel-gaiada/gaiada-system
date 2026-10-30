// SCP-5g (W5-B4) — the social audit's PURE request side (FRONTEND-BFF-CONTRACT §63.28.4): the bodies' and queries' validation, and the answer shapes.
// No I/O. The scoring is `audit-score.ts`'s, the rows `audit-data.ts`'s, the transactions `audit.service.ts`'s, the routes `audit.controller.ts`'s.
//
// Every refusal of a body is the §63.0 400 `{error, field}`: `missing_field` for a field that is absent, `invalid_field` for one that is there and
// wrong. A field named by its dotted path for a nested one: `scores.<key>.score`, `scores.<key>.note`, `publicNumbers.<key>`.
import { ScpRouteError } from "./pipeline-effects";
import {
  isHalfScore, isRealDay, type AutoEvidence, type BenchmarkFacts, type Fix, type NoneReason, type ScoredDimension, type Scorecard, type TypedScore,
} from "./audit-score";
import type { AuditRules } from "./rules";

export const AUDIT_SUBJECTS = ["client", "prospect"] as const;
export type AuditSubject = (typeof AUDIT_SUBJECTS)[number];
export const AUDIT_STATUSES = ["draft", "final"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const SUMMARY_VIAS = ["ai", "template", "typed"] as const;
export type SummaryVia = (typeof SUMMARY_VIAS)[number];

export const SUMMARY_MAX = 3000;
export const NOTE_MAX = 500;
export const PROSPECT_NAME_MAX = 200;
export const BUSINESS_TYPE_MAX = 60;
/** The largest whole count a public number may hold (a follower count of a very large account). */
export const PUBLIC_COUNT_MAX = 10_000_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
export const charLen = (s: string): number => [...s].length;

const missing = (field: string): never => { throw new ScpRouteError(400, "missing_field", { field }); };
const invalid = (field: string): never => { throw new ScpRouteError(400, "invalid_field", { field }); };

/** A text of 1 to `max` characters once trimmed. */
function requiredText(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return missing(field);
  if (typeof v !== "string") return invalid(field);
  const t = v.trim();
  if (t === "") return missing(field);
  if (charLen(t) > max) return invalid(field);
  return t;
}

/** A text of up to `max` characters, or null (absent, null and blank are "none"). */
function optionalText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return invalid(field);
  const t = v.trim();
  if (t === "") return null;
  if (charLen(t) > max) return invalid(field);
  return t;
}

/** A month: `YYYY-MM` or `YYYY-MM-01`, normalised to `YYYY-MM-01`. Another day of the month is not a month. */
export function parseMonth(v: unknown, field: string): string {
  if (typeof v !== "string") return invalid(field);
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v.trim());
  if (!m || (m[3] !== undefined && m[3] !== "01")) return invalid(field);
  const first = `${m[1]}-${m[2]}-01`;
  return isRealDay(first) ? first : invalid(field);
}

// ── The prospect's public numbers ─────────────────────────────────────────────────────────────────────────────────────

export interface PublicNumbers {
  followers?: number;
  postsLast30Days?: number;
  avgLikes?: number;
  avgComments?: number;
  lastPostOn?: string;
}
const PUBLIC_KEYS = ["followers", "postsLast30Days", "avgLikes", "avgComments", "lastPostOn"] as const;

/** `{followers, postsLast30Days, avgLikes, avgComments, lastPostOn}`, each optional (null drops it); counts are whole numbers, averages may have decimals. */
export function parsePublicNumbers(v: unknown, field = "publicNumbers"): PublicNumbers {
  if (v === null) return {};
  if (!isObj(v)) return invalid(field);
  const out: PublicNumbers = {};
  for (const k of Object.keys(v)) if (!(PUBLIC_KEYS as readonly string[]).includes(k)) return invalid(`${field}.${k}`);
  for (const k of ["followers", "postsLast30Days"] as const) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > PUBLIC_COUNT_MAX) return invalid(`${field}.${k}`);
    out[k] = x;
  }
  for (const k of ["avgLikes", "avgComments"] as const) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > PUBLIC_COUNT_MAX) return invalid(`${field}.${k}`);
    out[k] = Math.round(x * 100) / 100;
  }
  if (v.lastPostOn !== undefined && v.lastPostOn !== null) {
    if (!isRealDay(v.lastPostOn)) return invalid(`${field}.lastPostOn`);
    out.lastPostOn = v.lastPostOn;
  }
  return out;
}

// ── POST audits ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The body's subject, read BEFORE the gate (the gate is chosen from it). Null when absent or not a subject: the caller gates as a prospect's and then 400s. */
export function subjectOfBody(body: unknown): AuditSubject | null {
  return isObj(body) && (body.subject === "client" || body.subject === "prospect") ? body.subject : null;
}

/** The body's `engagementId` as a lower-case uuid: undefined when it is not one (then there is no client to look up). */
export function engagementIdOfBody(body: unknown): string | undefined {
  return isObj(body) && isUuid(body.engagementId) ? body.engagementId.toLowerCase() : undefined;
}

export type AuditCreate =
  | { subject: "client"; id: string | null; engagementId: string; month: string }
  | { subject: "prospect"; id: string | null; prospectName: string; businessType: string | null; publicNumbers: PublicNumbers };

/**
 * `POST audits` (63.28.4): `{id?, subject: 'client', engagementId, month?}` (month defaults to `lastFullMonth`) or
 * `{id?, subject: 'prospect', prospectName, businessType?, publicNumbers?}`. `currentMonth` (`YYYY-MM-01`) is the latest month a client audit may name.
 */
export function parseAuditCreate(body: unknown, months: { lastFullMonth: string; currentMonth: string }): AuditCreate {
  if (!isObj(body)) return invalid("body");
  const subject = body.subject;
  if (subject === undefined || subject === null) return missing("subject");
  if (subject !== "client" && subject !== "prospect") return invalid("subject");
  const allowed = subject === "client" ? ["id", "subject", "engagementId", "month"] : ["id", "subject", "prospectName", "businessType", "publicNumbers"];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return invalid(k);
  let id: string | null = null;
  if (body.id !== undefined && body.id !== null) {
    if (!isUuid(body.id)) return invalid("id");
    id = body.id.toLowerCase();
  }
  if (subject === "client") {
    if (body.engagementId === undefined || body.engagementId === null) return missing("engagementId");
    if (!isUuid(body.engagementId)) return invalid("engagementId");
    const month = body.month === undefined || body.month === null ? months.lastFullMonth : parseMonth(body.month, "month");
    if (month > months.currentMonth) return invalid("month");
    return { subject, id, engagementId: body.engagementId.toLowerCase(), month };
  }
  const prospectName = requiredText(body.prospectName, "prospectName", PROSPECT_NAME_MAX);
  const businessType = optionalText(body.businessType, "businessType", BUSINESS_TYPE_MAX);
  const publicNumbers = body.publicNumbers === undefined ? {} : parsePublicNumbers(body.publicNumbers);
  return { subject, id, prospectName, businessType, publicNumbers };
}

// ── PATCH audits/:auditId ─────────────────────────────────────────────────────────────────────────────────────────────

export interface AuditPatch {
  /** Per key: the entry to store, or null to drop it ("Use automatic"). Keys not named stay as they are. */
  scores?: Record<string, TypedScore | null>;
  summary?: { text: string | null; via: SummaryVia | null };
  month?: string;
  prospectName?: string;
  businessType?: string | null;
  publicNumbers?: PublicNumbers;
}

/**
 * `PATCH audits/:auditId` (63.28.4) on a DRAFT. `existing` is the audit's typed scores as stored (a score sent without a note keeps its note).
 *   scores   `{<key>: {score: 0 to 5 by halves | null, note?}}` or `{<key>: null}`; a key outside the scorecard is 400 `{field: 'scores.<key>'}`; a bad score
 *            is 400 `{field: 'scores.<key>.score'}`; a typed score on an AUTOMATIC dimension of a client's audit overrides it and needs a note
 *            (400 `{field: 'scores.<key>.note'}`); `{score: null}` with no note drops the entry.
 *   summary  text up to 3,000, or null; with `summaryVia` `ai`, `template` or `typed` (default `typed`; null clears both).
 *   A client's draft takes `month`; a prospect's takes `prospectName`, `businessType` and `publicNumbers`: another subject's field is 400.
 */
export function parseAuditPatch(
  body: unknown,
  a: { subject: AuditSubject; rules: AuditRules; existing: Readonly<Record<string, TypedScore>>; currentMonth: string },
): AuditPatch {
  if (!isObj(body)) return invalid("body");
  const own = a.subject === "client" ? ["month"] : ["prospectName", "businessType", "publicNumbers"];
  const allowed = ["scores", "summary", "summaryVia", ...own];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return invalid(k);
  const patch: AuditPatch = {};
  const dims = new Map(a.rules.dimensions.map((d) => [d.key, d]));

  if (has(body, "scores")) {
    const s = body.scores;
    if (!isObj(s)) return invalid("scores");
    const out: Record<string, TypedScore | null> = {};
    for (const key of Object.keys(s)) {
      const dim = dims.get(key);
      if (!dim) return invalid(`scores.${key}`);
      const entry = s[key];
      if (entry === null) { out[key] = null; continue; }
      if (!isObj(entry)) return invalid(`scores.${key}`);
      for (const k of Object.keys(entry)) if (k !== "score" && k !== "note") return invalid(`scores.${key}.${k}`);
      if (!has(entry, "score")) return missing(`scores.${key}.score`);
      const score = entry.score;
      if (score !== null && !isHalfScore(score)) return invalid(`scores.${key}.score`);
      let note: string;
      if (has(entry, "note") && entry.note !== undefined && entry.note !== null) {
        if (typeof entry.note !== "string") return invalid(`scores.${key}.note`);
        note = entry.note.trim();
        if (charLen(note) > NOTE_MAX) return invalid(`scores.${key}.note`);
      } else {
        note = a.existing[key]?.note ?? "";
      }
      if (score === null) {
        out[key] = note === "" ? null : { score: null, note };
        continue;
      }
      // A typed score on an automatic dimension of a client's audit overrides the computed one, and says why.
      if (a.subject === "client" && dim.source !== "typed" && note === "") return missing(`scores.${key}.note`);
      out[key] = { score, note };
    }
    patch.scores = out;
  }

  if (has(body, "summary") || has(body, "summaryVia")) {
    const text = has(body, "summary") ? body.summary : undefined;
    if (text === undefined) return missing("summary");
    if (text === null) {
      if (body.summaryVia !== undefined && body.summaryVia !== null) return invalid("summaryVia");
      patch.summary = { text: null, via: null };
    } else {
      if (typeof text !== "string") return invalid("summary");
      const t = text.trim();
      if (charLen(t) > SUMMARY_MAX) return invalid("summary");
      let via: SummaryVia = "typed";
      if (body.summaryVia !== undefined && body.summaryVia !== null) {
        if (typeof body.summaryVia !== "string" || !(SUMMARY_VIAS as readonly string[]).includes(body.summaryVia)) return invalid("summaryVia");
        via = body.summaryVia as SummaryVia;
      }
      patch.summary = t === "" ? { text: null, via: null } : { text: t, via };
    }
  }

  if (a.subject === "client") {
    if (has(body, "month")) {
      const m = parseMonth(body.month, "month");
      if (m > a.currentMonth) return invalid("month");
      patch.month = m;
    }
  } else {
    if (has(body, "prospectName")) patch.prospectName = requiredText(body.prospectName, "prospectName", PROSPECT_NAME_MAX);
    if (has(body, "businessType")) patch.businessType = optionalText(body.businessType, "businessType", BUSINESS_TYPE_MAX);
    if (has(body, "publicNumbers")) patch.publicNumbers = parsePublicNumbers(body.publicNumbers);
  }
  return patch;
}

/** The stored typed scores after a patch: a dropped key leaves, a named key is replaced, the rest stay. */
export function applyScoresPatch(existing: Readonly<Record<string, TypedScore>>, patch: Record<string, TypedScore | null>): Record<string, TypedScore> {
  const next: Record<string, TypedScore> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/** The stored `scores` jsonb, read defensively: only entries of the shape `{score: half | null, note: string}`. */
export function readStoredScores(raw: unknown): Record<string, TypedScore> {
  const out: Record<string, TypedScore> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!isObj(v)) continue;
    const score = v.score === null || isHalfScore(v.score) ? (v.score as number | null) : undefined;
    if (score === undefined) continue;
    out[k] = { score, note: typeof v.note === "string" ? v.note : "" };
  }
  return out;
}

// ── POST audits/:auditId/attach ───────────────────────────────────────────────────────────────────────────────────────

/** `{engagementId}`. */
export function parseAttach(body: unknown): { engagementId: string } {
  if (!isObj(body)) return invalid("body");
  for (const k of Object.keys(body)) if (k !== "engagementId") return invalid(k);
  if (body.engagementId === undefined || body.engagementId === null) return missing("engagementId");
  if (!isUuid(body.engagementId)) return invalid("engagementId");
  return { engagementId: body.engagementId.toLowerCase() };
}

// ── GET audits ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `?subject=client|prospect` (absent: both). */
export function parseAuditListQuery(q: Record<string, unknown>): { subject: AuditSubject | null } {
  for (const k of Object.keys(q)) if (k !== "subject") return invalid(k);
  const s = q.subject;
  if (s === undefined || s === "") return { subject: null };
  if (s !== "client" && s !== "prospect") return invalid("subject");
  return { subject: s };
}

// ── Answers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonRef { id: string; name: string }

/** One dimension as the scorecard answers it (63.28.4). */
export interface DimensionAnswer {
  key: string;
  label: string;
  kind: "automatic" | "typed";
  weight: number;
  advice: string;
  auto: { score: number | null; evidence: AutoEvidence; reason: NoneReason | null } | null;
  typed: TypedScore | null;
  used: number | null;
}

/** `GET audits/:auditId`, and the `audit` of every write. A draft's numbers are computed on the read; a final audit's are its `frozen`. */
export interface AuditAnswer {
  id: string;
  subject: AuditSubject;
  /** A client audit's client; a prospect audit's, once attached. */
  engagementId: string | null;
  /** The client's name, or the prospect's. */
  name: string;
  prospectName: string | null;
  businessType: string | null;
  /** `YYYY-MM`, a client audit's data month. */
  month: string | null;
  publicNumbers: PublicNumbers;
  status: AuditStatus;
  rulesRef: string;
  summary: string | null;
  summaryVia: SummaryVia | null;
  dimensions: DimensionAnswer[];
  overall: number | null;
  band: string | null;
  bandLabel: string | null;
  scored: number;
  total: number;
  fixes: Fix[];
  simulated: boolean;
  createdBy: PersonRef | null;
  createdAt: string;
  updatedAt: string;
  finalizedBy: PersonRef | null;
  finalizedAt: string | null;
  canWrite: boolean;
  canFinalize: boolean;
}

/** One row of `GET audits`. */
export interface AuditListItem {
  auditId: string | null;
  subject: AuditSubject;
  engagementId: string | null;
  name: string;
  status: AuditStatus | null;
  month: string | null;
  overall: number | null;
  band: string | null;
  bandLabel: string | null;
  scored: number;
  total: number;
  topFix: Fix | null;
  finalizedAt: string | null;
  simulated: boolean;
}

/** PURE. Worst first: the lowest overall leads, an audit with no score follows, a tie reads by name. */
export function sortWorstFirst<T extends { overall: number | null; name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.overall === null && b.overall !== null) return 1;
    if (a.overall !== null && b.overall === null) return -1;
    if (a.overall !== null && b.overall !== null && a.overall !== b.overall) return a.overall - b.overall;
    return a.name.localeCompare(b.name, "en") || 0;
  });
}

export const dimensionAnswer = (d: ScoredDimension): DimensionAnswer => ({
  key: d.key, label: d.label, kind: d.kind, weight: d.weight, advice: d.advice, auto: d.auto, typed: d.typed, used: d.used,
});

// ── Draft with AI (a proposal) ────────────────────────────────────────────────────────────────────────────────────────

export interface SummaryFacts {
  name: string;
  subject: AuditSubject;
  month: string | null;
  overall: number | null;
  bandLabel: string | null;
  scored: number;
  total: number;
  /** Each scored dimension with its score out of 5 (halves) and the numbers behind an automatic one. */
  dimensions: Array<{ label: string; used: number; automatic: boolean }>;
  fixes: Array<{ label: string; score: number; advice: string }>;
}

/**
 * PURE. The plain summary used when the gateway is down or its answer fails a check: the overall and band, the strongest dimension and the three fixes,
 * every number taken from the facts. Never longer than the column.
 */
export function templateSummary(f: SummaryFacts): string {
  const subject = f.subject === "client" ? `${f.name}'s social media${f.month ? ` for ${f.month}` : ""}` : `${f.name}'s social media`;
  if (f.overall === null) return `${subject}: nothing is scored yet, so there is no overall score. Score the dimensions to see where to start.`;
  const lines = [`${subject} scores ${f.overall} out of 100 (${f.bandLabel ?? "no band"}), with ${f.scored} of ${f.total} dimensions scored.`];
  const best = [...f.dimensions].sort((a, b) => b.used - a.used)[0];
  if (best) lines.push(`The strongest area is ${best.label} at ${best.used} out of 5.`);
  if (f.fixes.length > 0) {
    lines.push(`Start with: ${f.fixes.map((x) => `${x.label} (${x.score} out of 5)`).join(", ")}.`);
    lines.push(f.fixes[0].advice);
  }
  const text = lines.join(" ");
  return charLen(text) > SUMMARY_MAX ? [...text].slice(0, SUMMARY_MAX).join("") : text;
}

/** The numbers a summary may state: the facts' own, as digit-runs. */
export function summaryNumbers(f: SummaryFacts): Set<string> {
  const out = new Set<string>();
  const push = (v: unknown): void => {
    if (v === null || v === undefined) return;
    for (const m of String(v).matchAll(/\d+(?:\.\d+)?/g)) {
      out.add(m[0]);
      if (m[0].includes(".")) { out.add(String(Math.trunc(Number(m[0])))); out.add(String(Math.round(Number(m[0])))); }
    }
  };
  push(f.overall); push(f.scored); push(f.total); push(f.month); push(f.name); push(100); push(5);
  for (const d of f.dimensions) { push(d.used); push(d.label); }
  for (const x of f.fixes) { push(x.score); push(x.label); push(x.advice); }
  return out;
}

/** PURE. Digit-runs in `text` that no fact accounts for (thousands separators ignored): the numbers guard of the reports, over the audit's facts. */
export function ungroundedNumbers(text: string, f: SummaryFacts): string[] {
  const grounded = summaryNumbers(f);
  const normalised = text.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const bad: string[] = [];
  for (const m of normalised.matchAll(/\d+(?:\.\d+)?/g)) {
    const tok = m[0];
    if (grounded.has(tok)) continue;
    if (tok.includes(".") && grounded.has(String(Math.trunc(Number(tok))))) continue;
    if (!bad.includes(tok)) bad.push(tok);
  }
  return bad;
}

/** PURE. The prompt: who it is for, the only numbers it may state, the fixes. Replies with strict JSON `{summary}`. */
export function buildSummaryPrompt(f: SummaryFacts): string {
  const lines = [
    `You are writing the short summary of a social-media audit for "${f.name}"${f.month ? `, covering ${f.month}` : ""}. The audience is the Social Media team and the client's account manager.`,
  ];
  if (f.overall === null) {
    lines.push("Nothing is scored yet. Say so plainly. Do not invent or guess any number.");
  } else {
    lines.push(
      "Here are the ONLY numbers you may state, exactly as given:\n"
        + `- Overall: ${f.overall} out of 100 (${f.bandLabel ?? "no band"})\n`
        + `- Dimensions scored: ${f.scored} of ${f.total}\n`
        + f.dimensions.map((d) => `- ${d.label}: ${d.used} out of 5`).join("\n"),
    );
    if (f.fixes.length > 0) lines.push(`The three weakest areas, with the advice to give:\n${f.fixes.map((x) => `- ${x.label} (${x.score} out of 5): ${x.advice}`).join("\n")}`);
  }
  lines.push(
    "Write one short paragraph of 3 to 5 sentences: where the account stands, what is strongest, and the first two things to fix. "
      + "NEVER state a number you were not given above. Do not promise results. Do not mention a competitor.",
    'Reply with STRICT JSON only, no prose, no markdown fences: {"summary": "<the paragraph>"}',
  );
  return lines.join("\n\n");
}

/** PURE, never throws. The gateway's text to a proposal: the parsed paragraph when it is a string within the column and states no number the facts lack, else the template. */
export function parseSummaryDraft(raw: string | null, f: SummaryFacts): { summary: string; draftedVia: "ai" | "template" } {
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { summary?: unknown };
        const text = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
        if (text !== "" && charLen(text) <= SUMMARY_MAX && ungroundedNumbers(text, f).length === 0) return { summary: text, draftedVia: "ai" };
      } catch {
        /* malformed JSON: the template below */
      }
    }
  }
  return { summary: templateSummary(f), draftedVia: "template" };
}

// ── The frozen scorecard ──────────────────────────────────────────────────────────────────────────────────────────────


/** What `finalize` writes into `social_audits.frozen` (63.28.2): the whole scorecard as it stood, and the scorecard itself it was scored under. */
export interface FrozenAudit {
  fixtureVersion: string;
  rulesRef: string;
  scorecard: AuditRules;
  subject: AuditSubject;
  month: string | null;
  businessType: string | null;
  publicNumbers: PublicNumbers;
  dimensions: ScoredDimension[];
  overall: number | null;
  band: { key: string; label: string } | null;
  scored: number;
  total: number;
  fixes: Fix[];
  simulated: boolean;
  /** The benchmark the engagement rate was measured against (client audits on the company's median). */
  benchmark: BenchmarkFacts | null;
}

/** PURE. The frozen record of a scorecard. */
export function buildFrozen(a: {
  card: Scorecard; scorecard: AuditRules; rulesRef: string; fixtureVersion: string; subject: AuditSubject; month: string | null;
  businessType: string | null; publicNumbers: PublicNumbers; simulated: boolean; benchmark: BenchmarkFacts | null;
}): FrozenAudit {
  return {
    fixtureVersion: a.fixtureVersion, rulesRef: a.rulesRef, scorecard: a.scorecard, subject: a.subject, month: a.month, businessType: a.businessType,
    publicNumbers: a.publicNumbers, dimensions: a.card.dimensions, overall: a.card.overall, band: a.card.band, scored: a.card.scored, total: a.card.total,
    fixes: a.card.fixes, simulated: a.simulated, benchmark: a.benchmark,
  };
}

/** The frozen record as stored, read defensively (a final audit answers it, never a recomputation). Null when it is not the shape. */
export function readFrozen(raw: unknown): FrozenAudit | null {
  if (!isObj(raw) || !Array.isArray(raw.dimensions) || !Array.isArray(raw.fixes)) return null;
  return raw as unknown as FrozenAudit;
}

/** PURE. The facts a summary is drafted from, out of a scorecard. */
export function summaryFactsOf(a: { name: string; subject: AuditSubject; month: string | null; card: Pick<Scorecard, "overall" | "band" | "scored" | "total" | "dimensions" | "fixes"> }): SummaryFacts {
  return {
    name: a.name, subject: a.subject, month: a.month, overall: a.card.overall, bandLabel: a.card.band?.label ?? null, scored: a.card.scored, total: a.card.total,
    dimensions: a.card.dimensions.filter((d): d is ScoredDimension & { used: number } => d.used !== null).map((d) => ({ label: d.label, used: d.used, automatic: d.auto !== null && d.auto.score !== null && (d.typed === null || d.typed.score === null) })),
    fixes: a.card.fixes.map((f) => ({ label: f.label, score: f.score, advice: f.advice })),
  };
}

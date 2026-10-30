// SCP-5g (BFF §63.28) — the social audit: the types of every answer, their defensive parsing, the words for the scores, the reasons and every refusal, the form's own checks and the pure rules of
// the two pages. No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialAudit-data.ts` (server-only, `ReadResult`), the writes in `lib/socialAuditActions.ts` ("use server"); DEMO_MODE answers every route from `lib/demoSocialAudit.ts`, in the
// server's order of checks.
//
// THE SCORECARD. Twelve dimensions as the company's rules set them (BFF §63.30; the seed is the design's twelve), each 0 to 5 by halves. For a client six are AUTOMATIC from the pipeline (shown with
// their evidence, or with the reason when they cannot be scored) and six are typed; a typed score may override an automatic one, with a note. A prospect has no pipeline, so all twelve are typed.
// The overall is out of 100 over the scored dimensions only, the band follows it, and the three weakest dimensions are the fixes. A DRAFT is live; FINALIZE freezes it as a dated record.
// WHO (SCP-Q34): a client's audit is written by its officer, the HoD or the GM (the owner and the superadmin too); a prospect's by the four. The server decides each write (`canWrite`,
// `canFinalize` on the read, and the 403 in words). A score is always shown in words and in numbers, never colour alone.
import { refusalText, type Refusal } from "./socialPipeline";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

export const AUDIT_SUBJECTS = ["client", "prospect"] as const;
export type AuditSubject = (typeof AUDIT_SUBJECTS)[number];
export const AUDIT_STATUSES = ["draft", "final"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const SUMMARY_VIAS = ["ai", "template", "typed"] as const;
export type SummaryVia = (typeof SUMMARY_VIAS)[number];

/** The server's limits (BFF §63.28.2), mirrored for the form's own checks. */
export const AUDIT_LIMITS = { note: 500, summary: 3000, prospectName: 200, businessType: 60, maxScore: 5, count: 10_000_000_000 } as const;

const isSubject = (v: unknown): v is AuditSubject => v === "client" || v === "prospect";

// ── Scores in words ──────────────────────────────────────────────────────────────────────────────

/** A score is a half-step from 0 to 5. */
export const isHalfScore = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= AUDIT_LIMITS.maxScore && Number.isInteger(n * 2);
/** "3.5", "4": no trailing zero. */
export const scoreText = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** "3.5 out of 5": words and number together, never colour alone. */
export const scoreWords = (n: number | null): string => (n === null ? "Not scored" : `${scoreText(n)} out of 5`);
/** The word for a half-step, so a bar or a chip is also read: 0 to 1 weak, 1.5 to 2.5 low, 3 to 3.5 fair, 4 to 5 strong. */
export function scoreBand(n: number): string {
  if (n >= 4) return "strong";
  if (n >= 3) return "fair";
  if (n >= 1.5) return "low";
  return "weak";
}
export const HALF_STEPS: readonly number[] = Array.from({ length: 11 }, (_, i) => i / 2);

/** "62 out of 100, Fair", or "No overall score yet". */
export const overallWords = (overall: number | null, bandLabel: string | null): string =>
  overall === null ? "No overall score yet" : `${overall} out of 100${bandLabel ? `, ${bandLabel}` : ""}`;

/** "7 of 12 dimensions scored". */
export const scoredWords = (scored: number, total: number): string => `${scored} of ${total} dimensions scored`;

// ── Why an automatic score is none ───────────────────────────────────────────────────────────────

export const NONE_REASON_WORDS: Readonly<Record<string, string>> = {
  no_target: "The client has no monthly target (posts per cycle) yet, so there is nothing to measure against.",
  no_allocated_formats: "The client has no formats allocated yet, so there is no mix to measure.",
  no_rate: "No post that went live this month has a reach, so there is no engagement rate.",
  no_benchmark: "There is no benchmark to compare against: no other client of the company has a rate to measure with, or no rate is set for this business type.",
  no_reels: "No reel went live this month.",
  no_reel_rate: "No reel this month has a reach, so there is no rate for reels.",
  no_feed_baseline: "No other feed post this month has a rate to compare the reels with.",
  no_agreed_budget: "No boost budget was agreed for the three months to this one.",
};
export const noneReasonWords = (code: string | null): string => (code ? NONE_REASON_WORDS[code] ?? "It cannot be scored from the pipeline yet." : "It cannot be scored from the pipeline yet.");

export interface AutoEvidence { actual: number | null; expected: number | null; unit: string; [detail: string]: unknown }

const UNIT_WORDS: Readonly<Record<string, [string, string]>> = {
  posts: ["post", "posts"], formats: ["format", "formats"], weeks: ["week", "weeks"], cycles: ["cycle", "cycles"],
};
const rateText = (r: number): string => `${(Math.round(r * 10000) / 100).toString()}%`;
const unitNumber = (n: number | null, unit: string): string => {
  if (n === null) return "not known";
  if (unit === "rate") return rateText(n);
  const w = UNIT_WORDS[unit];
  return w ? `${n} ${n === 1 ? w[0] : w[1]}` : String(n);
};

/** What an automatic score was read from, in one line: "4 posts against 12 posts", "engagement rate 3.2% against 2.8%". */
export function evidenceWords(e: AutoEvidence): string {
  const lead = e.unit === "rate" ? "Rate " : "";
  return `${lead}${unitNumber(e.actual, e.unit)} against ${unitNumber(e.expected, e.unit)}`;
}

// ── The scorecard (GET audits/:id) ───────────────────────────────────────────────────────────────

export interface AuditDimension {
  key: string;
  label: string;
  /** `automatic` for a dimension a rule scores for a client; it is typed by hand for a prospect (then `auto` is null). */
  kind: "automatic" | "typed";
  weight: number;
  advice: string;
  auto: { score: number | null; evidence: AutoEvidence; reason: string | null } | null;
  typed: { score: number | null; note: string } | null;
  /** The score that counts: the typed one when it has a score, else the automatic one, else none. */
  used: number | null;
}

export interface AuditFix { key: string; label: string; score: number; advice: string }

export interface PublicNumbers { followers?: number; postsLast30Days?: number; avgLikes?: number; avgComments?: number; lastPostOn?: string }
export const PUBLIC_KEYS = ["followers", "postsLast30Days", "avgLikes", "avgComments", "lastPostOn"] as const;
export const PUBLIC_LABEL: Readonly<Record<(typeof PUBLIC_KEYS)[number], string>> = {
  followers: "Followers", postsLast30Days: "Posts in the last 30 days", avgLikes: "Average likes", avgComments: "Average comments", lastPostOn: "Date of the last post",
};

export interface AuditPerson { id: string; name: string }

export interface AuditDetail {
  id: string;
  subject: AuditSubject;
  /** A client audit's client; a prospect audit's once attached. */
  engagementId: string | null;
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
  dimensions: AuditDimension[];
  overall: number | null;
  band: string | null;
  bandLabel: string | null;
  scored: number;
  total: number;
  fixes: AuditFix[];
  simulated: boolean;
  createdBy: AuditPerson | null;
  createdAt: string;
  updatedAt: string;
  finalizedBy: AuditPerson | null;
  finalizedAt: string | null;
  canWrite: boolean;
  canFinalize: boolean;
}

const person = (v: unknown): AuditPerson | null => (isObj(v) && typeof v.id === "string" ? { id: v.id, name: str(v.name) ?? "Someone" } : null);

function asEvidence(v: unknown): AutoEvidence {
  const o = isObj(v) ? v : {};
  return { ...o, actual: num(o.actual), expected: num(o.expected), unit: str(o.unit) ?? "" };
}

export function asDimension(raw: unknown): AuditDimension {
  if (!isObj(raw) || typeof raw.key !== "string" || typeof raw.label !== "string") throw new Error("audit: not a dimension");
  const auto = isObj(raw.auto) ? { score: num(raw.auto.score), evidence: asEvidence(raw.auto.evidence), reason: str(raw.auto.reason) } : null;
  const typed = isObj(raw.typed) ? { score: num(raw.typed.score), note: typeof raw.typed.note === "string" ? raw.typed.note : "" } : null;
  return {
    key: raw.key, label: raw.label, kind: raw.kind === "typed" ? "typed" : "automatic", weight: num(raw.weight) ?? 1, advice: str(raw.advice) ?? "", auto, typed, used: num(raw.used),
  };
}

const asFix = (raw: unknown): AuditFix | null =>
  isObj(raw) && typeof raw.key === "string" && typeof raw.label === "string" && num(raw.score) !== null
    ? { key: raw.key, label: raw.label, score: raw.score as number, advice: str(raw.advice) ?? "" } : null;

function asPublic(raw: unknown): PublicNumbers {
  const out: PublicNumbers = {};
  if (!isObj(raw)) return out;
  for (const k of ["followers", "postsLast30Days", "avgLikes", "avgComments"] as const) {
    const n = num(raw[k]);
    if (n !== null) out[k] = n;
  }
  if (typeof raw.lastPostOn === "string") out.lastPostOn = raw.lastPostOn;
  return out;
}

export function asAuditDetail(raw: unknown): AuditDetail {
  if (!isObj(raw) || typeof raw.id !== "string" || !isSubject(raw.subject) || (raw.status !== "draft" && raw.status !== "final") || !Array.isArray(raw.dimensions)) throw new Error("audit: not an audit");
  return {
    id: raw.id, subject: raw.subject, engagementId: str(raw.engagementId), name: str(raw.name) ?? "", prospectName: str(raw.prospectName), businessType: str(raw.businessType),
    month: str(raw.month), publicNumbers: asPublic(raw.publicNumbers), status: raw.status, rulesRef: str(raw.rulesRef) ?? "", summary: str(raw.summary),
    summaryVia: SUMMARY_VIAS.includes(raw.summaryVia as SummaryVia) ? (raw.summaryVia as SummaryVia) : null, dimensions: raw.dimensions.map(asDimension), overall: num(raw.overall),
    band: str(raw.band), bandLabel: str(raw.bandLabel), scored: count(raw.scored), total: count(raw.total), fixes: arr(raw.fixes).map(asFix).filter((f): f is AuditFix => f !== null),
    simulated: raw.simulated === true, createdBy: person(raw.createdBy), createdAt: str(raw.createdAt) ?? "", updatedAt: str(raw.updatedAt) ?? "", finalizedBy: person(raw.finalizedBy),
    finalizedAt: str(raw.finalizedAt), canWrite: raw.canWrite === true, canFinalize: raw.canFinalize === true,
  };
}

/** `POST audits` answers `{audit, created}`; a write answers `{audit}`; `finalize` and `attach` add `alreadyApplied` on a replay. */
export function asAuditWrite(raw: unknown): { audit: AuditDetail; created: boolean; alreadyApplied: boolean } {
  if (!isObj(raw)) throw new Error("audit: not an audit write");
  return { audit: asAuditDetail(raw.audit), created: raw.created === true, alreadyApplied: raw.alreadyApplied === true };
}

// ── The list (GET audits) ────────────────────────────────────────────────────────────────────────

export interface AuditListItem {
  /** Null for a client with no audit yet. */
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
  topFix: AuditFix | null;
  finalizedAt: string | null;
  simulated: boolean;
}

export function asAuditListItem(raw: unknown): AuditListItem {
  if (!isObj(raw) || !isSubject(raw.subject) || typeof raw.name !== "string") throw new Error("audit: not a list row");
  return {
    auditId: str(raw.auditId), subject: raw.subject, engagementId: str(raw.engagementId), name: raw.name, status: raw.status === "draft" || raw.status === "final" ? raw.status : null,
    month: str(raw.month), overall: num(raw.overall), band: str(raw.band), bandLabel: str(raw.bandLabel), scored: count(raw.scored), total: count(raw.total), topFix: asFix(raw.topFix),
    finalizedAt: str(raw.finalizedAt), simulated: raw.simulated === true,
  };
}

export interface AuditList { items: AuditListItem[]; canAddProspect: boolean }
export function asAuditList(raw: unknown): AuditList {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("audits: not a list of audits");
  return { items: raw.items.map(asAuditListItem), canAddProspect: raw.canAddProspect === true };
}

/** `POST audits/:id/ai-summary`: a proposal; nothing is saved by it. */
export interface SummaryProposal { summary: string; draftedVia: "ai" | "template" }
export function asSummaryProposal(raw: unknown): SummaryProposal {
  if (!isObj(raw) || typeof raw.summary !== "string") throw new Error("ai-summary: not a proposal");
  return { summary: raw.summary, draftedVia: raw.draftedVia === "ai" ? "ai" : "template" };
}

/** What the page says about a proposal's source. The template is a plain, honest fallback and says so. */
export const draftedViaWords = (via: "ai" | "template"): string =>
  via === "ai"
    ? "Drafted with AI from the scores and the evidence. Read it, change what you want, and save: nothing is saved until you do."
    : "The AI could not be used just now (it was down, or its answer stated a number it was not given), so this is the plain summary from the scores. Read it, change what you want, and save: nothing is saved until you do.";

// ── The rows in words ────────────────────────────────────────────────────────────────────────────

/** "Draft" or "Final, 12 Oct 2026" is drawn by the page with `formatDate`; this is the state word, and "No audit yet" for a client without one. */
export const statusWords = (s: AuditStatus | null): string => (s === "draft" ? "Draft" : s === "final" ? "Final" : "No audit yet");
export const subjectWords = (s: AuditSubject): string => (s === "client" ? "Client" : "Prospect");

/** A list row's score for a person: "62 out of 100, Fair · 7 of 12 scored", or "Not scored yet". */
export function rowScoreWords(r: Pick<AuditListItem, "overall" | "bandLabel" | "scored" | "total" | "auditId">): string {
  if (r.auditId === null) return "No audit yet";
  if (r.overall === null) return `Not scored yet · ${r.scored} of ${r.total} scored`;
  return `${overallWords(r.overall, r.bandLabel)} · ${r.scored} of ${r.total} scored`;
}

// ── Who may, in words ────────────────────────────────────────────────────────────────────────────

/** SCP-Q34. Shown beside a button the server refused, and as the page's note on who writes. */
export const CLIENT_WRITE_REASON = "Only this client's officer, the Social Media head, the GM, the owner or the superadmin can write a client's audit.";
export const PROSPECT_WRITE_REASON = "Only the Social Media head, the GM, the owner or the superadmin can write a prospect's audit.";
export const ATTACH_REASON = "Only the Social Media head, the GM, the owner or the superadmin can attach a prospect's audit to a client.";
export const writeReason = (subject: AuditSubject): string => (subject === "client" ? CLIENT_WRITE_REASON : PROSPECT_WRITE_REASON);

export type AuditWriteKind = "start" | "start_prospect" | "save" | "ai_summary" | "finalize" | "attach" | "delete";

const FIELD_WORDS: Readonly<Record<string, string>> = {
  month: "The month must be a month that has begun, such as 2026-09.",
  prospectName: `The prospect's name is 1 to ${AUDIT_LIMITS.prospectName} characters.`,
  businessType: `The business type is up to ${AUDIT_LIMITS.businessType} characters.`,
  summary: `The summary is up to ${AUDIT_LIMITS.summary} characters.`,
  summaryVia: "The summary's source is not valid.",
  engagementId: "That client is not valid.",
  subject: "An audit is for a client or a prospect.",
  id: "That audit belongs to someone else.",
  publicNumbers: "The public numbers are not valid.",
  scores: "The scores are not valid.",
};

/** A refusal of a write in a sentence. A 403 says who may; a 400 field is worded (a score, its note, a public number); a 404 and a 409 are the contract's words. */
export function auditRefusalText(r: Refusal, kind: AuditWriteKind = "save"): string {
  if (r.status === 403) {
    if (r.reason === "assurance_required" || r.error === "automation_cannot_act" || r.error === "not_officer_or_approver" || r.error === "not_a_social_approver") return refusalText(r);
    return `You cannot do this. ${kind === "attach" ? ATTACH_REASON : kind === "start_prospect" ? PROSPECT_WRITE_REASON : "The Social Media head, the GM, the owner and the superadmin can; so can the client's officer for a client's audit."}`;
  }
  if (r.error === "invalid_field" || r.error === "missing_field") {
    const f = r.field ?? "";
    let m = /^scores\.([^.]+)\.score$/.exec(f);
    if (m) return `The score for ${m[1].replace(/_/g, " ")} must be from 0 to 5 in steps of a half.`;
    m = /^scores\.([^.]+)\.note$/.exec(f);
    if (m) return `A score that replaces an automatic one needs a note saying why (up to ${AUDIT_LIMITS.note} characters).`;
    m = /^publicNumbers\.(.+)$/.exec(f);
    if (m) return `The public number "${PUBLIC_LABEL[m[1] as keyof typeof PUBLIC_LABEL] ?? m[1]}" is not valid.`;
    if (f.startsWith("scores.")) return "That is not one of this audit's dimensions.";
    if (FIELD_WORDS[f]) return FIELD_WORDS[f];
  }
  return refusalText(r);
}

// ── The form (what the person types) and its checks ──────────────────────────────────────────────

export interface DimensionForm { score: string; note: string }
export interface AuditForm {
  scores: Record<string, DimensionForm>;
  summary: string;
  month: string;
  prospectName: string;
  businessType: string;
  publicNumbers: Record<(typeof PUBLIC_KEYS)[number], string>;
}

/** A score field's value: "" is not scored, otherwise the half-step as text. */
const scoreField = (n: number | null): string => (n === null ? "" : scoreText(n));

export function formFromDetail(d: AuditDetail): AuditForm {
  const scores: Record<string, DimensionForm> = {};
  for (const x of d.dimensions) scores[x.key] = { score: scoreField(x.typed?.score ?? null), note: x.typed?.note ?? "" };
  const p = d.publicNumbers;
  return {
    scores, summary: d.summary ?? "", month: d.month ?? "", prospectName: d.prospectName ?? d.name, businessType: d.businessType ?? "",
    publicNumbers: {
      followers: p.followers === undefined ? "" : String(p.followers), postsLast30Days: p.postsLast30Days === undefined ? "" : String(p.postsLast30Days),
      avgLikes: p.avgLikes === undefined ? "" : String(p.avgLikes), avgComments: p.avgComments === undefined ? "" : String(p.avgComments), lastPostOn: p.lastPostOn ?? "",
    },
  };
}

/** A proposal laid over the form: it fills the summary and saves nothing. */
export const formWithSummary = (f: AuditForm, summary: string): AuditForm => ({ ...f, summary });

export const sameForm = (a: AuditForm, b: AuditForm): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether a dimension of this audit is scored by a rule (so a typed score on it overrides, and needs a note). */
export const isOverride = (subject: AuditSubject, d: Pick<AuditDimension, "kind" | "auto">): boolean => subject === "client" && d.kind === "automatic" && d.auto !== null;

export type Check<B> = { ok: true; body: B } | { ok: false; field: string; message: string };
const no = (field: string, message: string): { ok: false; field: string; message: string } => ({ ok: false, field, message });
const len = (s: string): number => [...s].length;

const isMonth = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/**
 * The body of `PATCH audits/:id`: only what changed against `d`, and the server's own rules checked before the request: a score is a half-step from 0 to 5 or empty, a score that
 * replaces an automatic one needs a note, notes up to 500 characters, the summary up to 3,000 (a typed summary says `summaryVia: typed`; a proposal the person kept says its own).
 * An emptied score field drops the typed score ("Use automatic"). Nothing changed is no request.
 */
export function buildAuditPatch(d: AuditDetail, f: AuditForm, opts: { summaryVia?: SummaryVia | null } = {}): Check<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const scores: Record<string, { score: number | null; note: string } | null> = {};
  for (const x of d.dimensions) {
    const cur = f.scores[x.key] ?? { score: "", note: "" };
    const before = { score: scoreField(x.typed?.score ?? null), note: x.typed?.note ?? "" };
    if (cur.score === before.score && cur.note.trim() === before.note.trim()) continue;
    const note = cur.note.trim();
    if (len(note) > AUDIT_LIMITS.note) return no(`scores.${x.key}.note`, `${x.label}: the note is over ${AUDIT_LIMITS.note} characters.`);
    if (cur.score === "") {
      // No score typed: the typed entry goes (or keeps only a note on a dimension scored by hand with no number).
      scores[x.key] = note === "" ? null : { score: null, note };
      continue;
    }
    const n = Number(cur.score);
    if (!isHalfScore(n)) return no(`scores.${x.key}.score`, `${x.label}: a score is from 0 to 5 in steps of a half.`);
    if (isOverride(d.subject, x) && note === "") return no(`scores.${x.key}.note`, `${x.label}: a score that replaces the automatic one needs a note saying why.`);
    scores[x.key] = { score: n, note };
  }
  if (Object.keys(scores).length > 0) out.scores = scores;
  const summary = f.summary.trim();
  if (summary !== (d.summary ?? "")) {
    if (len(summary) > AUDIT_LIMITS.summary) return no("summary", `The summary is over ${AUDIT_LIMITS.summary} characters.`);
    out.summary = summary === "" ? null : summary;
    if (summary !== "") out.summaryVia = opts.summaryVia ?? "typed";
  }
  if (d.subject === "client") {
    if (f.month !== (d.month ?? "")) {
      if (!isMonth(f.month)) return no("month", "Pick the month the data is from.");
      out.month = f.month;
    }
  } else {
    const name = f.prospectName.trim();
    if (name !== (d.prospectName ?? d.name)) {
      if (len(name) < 1) return no("prospectName", "Give the prospect a name.");
      if (len(name) > AUDIT_LIMITS.prospectName) return no("prospectName", `The name is over ${AUDIT_LIMITS.prospectName} characters.`);
      out.prospectName = name;
    }
    const bt = f.businessType.trim();
    if (bt !== (d.businessType ?? "")) {
      if (len(bt) > AUDIT_LIMITS.businessType) return no("businessType", `The business type is over ${AUDIT_LIMITS.businessType} characters.`);
      out.businessType = bt === "" ? null : bt;
    }
    const pub = buildPublicNumbers(f.publicNumbers);
    if (!pub.ok) return pub;
    if (JSON.stringify(pub.body) !== JSON.stringify(d.publicNumbers)) out.publicNumbers = pub.body;
  }
  if (Object.keys(out).length === 0) return no("", "Nothing has changed.");
  return { ok: true, body: out };
}

/** The prospect's public numbers from the form's text: counts are whole numbers, averages may have decimals, the date is a real day. A blank drops the number. */
export function buildPublicNumbers(f: AuditForm["publicNumbers"]): Check<PublicNumbers> {
  const out: PublicNumbers = {};
  for (const k of ["followers", "postsLast30Days"] as const) {
    const t = f[k].trim();
    if (t === "") continue;
    if (!/^\d+$/.test(t) || Number(t) > AUDIT_LIMITS.count) return no(`publicNumbers.${k}`, `${PUBLIC_LABEL[k]}: a whole number, 0 or more.`);
    out[k] = Number(t);
  }
  for (const k of ["avgLikes", "avgComments"] as const) {
    const t = f[k].trim();
    if (t === "") continue;
    if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > AUDIT_LIMITS.count) return no(`publicNumbers.${k}`, `${PUBLIC_LABEL[k]}: a number, 0 or more, with at most two decimals.`);
    out[k] = Math.round(Number(t) * 100) / 100;
  }
  const d = f.lastPostOn.trim();
  if (d !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) return no("publicNumbers.lastPostOn", `${PUBLIC_LABEL.lastPostOn}: a real date.`);
    out.lastPostOn = d;
  }
  return { ok: true, body: out };
}

/** The body of a new prospect's audit: a name, an optional business type and the public numbers. */
export function buildProspectCreate(f: { prospectName: string; businessType: string; publicNumbers: AuditForm["publicNumbers"] }, id: string): Check<Record<string, unknown>> {
  const name = f.prospectName.trim();
  if (len(name) < 1) return no("prospectName", "Give the prospect a name.");
  if (len(name) > AUDIT_LIMITS.prospectName) return no("prospectName", `The name is over ${AUDIT_LIMITS.prospectName} characters.`);
  const bt = f.businessType.trim();
  if (len(bt) > AUDIT_LIMITS.businessType) return no("businessType", `The business type is over ${AUDIT_LIMITS.businessType} characters.`);
  const pub = buildPublicNumbers(f.publicNumbers);
  if (!pub.ok) return pub;
  return { ok: true, body: { id, subject: "prospect", prospectName: name, ...(bt ? { businessType: bt } : {}), ...(Object.keys(pub.body).length ? { publicNumbers: pub.body } : {}) } };
}

export const emptyPublicNumbers = (): AuditForm["publicNumbers"] => ({ followers: "", postsLast30Days: "", avgLikes: "", avgComments: "", lastPostOn: "" });

// ── The pages' rules ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_LIST_PATH = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/social-audit`;
export const auditHref = (deptId: string, auditId: string): string => `${AUDIT_LIST_PATH(deptId)}/${encodeURIComponent(auditId)}`;

/** The list's filter: the query's `subject`, ignored when it is not one (the whole list). */
export function parseAuditSubject(q: { subject?: string | string[] }): AuditSubject | null {
  const v = typeof q.subject === "string" ? q.subject : q.subject?.[0];
  return isSubject(v) ? v : null;
}
export const auditListHref = (deptId: string, subject: AuditSubject | null): string => `${AUDIT_LIST_PATH(deptId)}${subject ? `?subject=${subject}` : ""}`;

/** What a draft's buttons are, from the server's two flags and the state. `reason` is the sentence beside a disabled button. */
export interface AuditButtons {
  editable: boolean;
  save: boolean;
  aiSummary: boolean;
  finalize: { shown: boolean; allowed: boolean; reason: string | null };
  remove: { shown: boolean; allowed: boolean };
  attach: { shown: boolean; allowed: boolean; reason: string | null };
}

export function buttonsFor(d: Pick<AuditDetail, "subject" | "status" | "canWrite" | "canFinalize" | "engagementId">, opts: { dirty?: boolean } = {}): AuditButtons {
  const draft = d.status === "draft";
  const reason = writeReason(d.subject);
  return {
    editable: draft && d.canWrite,
    save: draft && d.canWrite,
    aiSummary: draft && d.canWrite,
    finalize: {
      shown: draft,
      allowed: d.canFinalize && !opts.dirty,
      reason: !d.canFinalize ? reason : opts.dirty ? "Save your changes first: finalizing freezes what is saved." : null,
    },
    remove: { shown: draft, allowed: d.canWrite },
    attach: {
      shown: d.subject === "prospect" && d.engagementId === null,
      allowed: d.canWrite,
      reason: d.canWrite ? null : ATTACH_REASON,
    },
  };
}

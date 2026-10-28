// AIP-09 — the PURE scorer of the tier eval (no I/O, no clock, no network). The runner (run-eval.ts) feeds it what the gateway answered.
//
// THE THRESHOLDS ARE THE GATE. Change one only with the reason written next to it, and keep the run's JSON of the change as evidence.
import { parseTriageDraft as parseSocialTriage } from "../../social/ai-drafts";
import { parseTriageDraft as parseAuditTriage, type TriageFindingFact } from "../../search/ai-drafts";

/** The text the gateway's echo provider returns when no provider key is configured (ai-gateway-go internal/providers/echo.go). Never a model answer. */
export const ECHO_PREFIX = "[echo — no provider key configured]";

// ── thresholds ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A summary shorter than this is not a summary (a refusal, "ok", a stub). */
export const SUMMARY_MIN_CHARS = 80;
/** Compaction: the rolling summary is pasted into EVERY later prompt of the thread, next to a recent-transcript budget of
 *  ASSISTANT_CONTEXT_CHAR_BUDGET = 12,000 chars (config.ts) and a 2,000-char memory block. The prompt asks for "a few dense sentences".
 *  1,500 chars is ~12% of the transcript budget: roomy for a few dense sentences, but a model that rambles past it would crowd the
 *  budget compaction exists to protect, so it fails. */
export const COMPACTION_SUMMARY_MAX_CHARS = 1_500;
/** Hub `llm.summarize` ("concisely, for a work context") of a 2,000-4,000 word (12-25k chars) meeting: 3,000 chars (~500 words) is a page,
 *  still an order of magnitude shorter than the source. Longer is not "concise". */
export const HUB_SUMMARY_MAX_CHARS = 3_000;
/** A case's summary must keep at least this share of its must-keep facts (names, numbers, dates, decisions). 0.8: one lost fact in five is
 *  tolerable for a summary, two is not; a dense summary of 5-8 facts must keep 4-7. */
export const SUMMARY_MIN_RECALL = 0.8;
/** The `summarise` class passes when at least this share of its cases pass. 8 of 9 cases (0.889) passes, 7 of 9 (0.778) does not: one
 *  unlucky sample is allowed, a pattern is not. An invented fact (must-not-appear probe) fails the class outright regardless of this rate. */
export const SUMMARISE_MIN_PASS_RATE = 0.85;
/** The `classify` class passes at this accuracy over its items (an item is right only when EVERY label axis is right; an answer the REAL
 *  parser rejects is wrong). 0.8 = 8 of 10: the labels in the cases are unambiguous by construction, a cheaper model that misses more
 *  than two is not safe to put in front of an inbox. */
export const CLASSIFY_MIN_ACCURACY = 0.8;

// ── types ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type TaskClass = "summarise" | "classify";
export type Verdict = "PASS" | "FAIL" | "INVALID";
export type CaseStatus = "pass" | "fail" | "invalid";

/** A fact the summary must keep: a string, or a list of acceptable spellings (any one is enough). */
export type Fact = string | readonly string[];

export interface SummaryCase {
  id: string;
  task: "summarise";
  kind: "compaction" | "hub";
  /** Prompt-builder input (excerpt or meeting text). */
  source: string;
  mustKeep: readonly Fact[];
  /** Plausible facts that are NOT in the source: a hit means the model invented one. */
  mustNotAppear: readonly Fact[];
}

export interface SocialLabel { sentiment: string; category: string; urgency: string }
export interface SocialClassifyCase {
  id: string;
  task: "classify";
  kind: "social";
  network: "instagram" | "facebook" | "tiktok" | "linkedin" | "x" | "youtube" | "threads";
  engagementName: string;
  messages: Array<{ authorHandle: string | null; body: string; postedAt: string }>;
  expected: SocialLabel;
}
export interface AuditClassifyCase {
  id: string;
  task: "classify";
  kind: "audit";
  findings: TriageFindingFact[];
  /** The finding codes whose fix the answer must return, and the one the summary must name as the first priority. */
  expectedFixCodes: readonly string[];
  priorityCode: string;
}
export type ClassifyCase = SocialClassifyCase | AuditClassifyCase;
export type EvalCase = SummaryCase | ClassifyCase;

export interface CaseResult {
  id: string;
  task: TaskClass;
  status: CaseStatus;
  /** Concrete, human-readable reasons (empty on a pass): what was missing, what was invented, expected vs got. */
  reasons: string[];
  /** Summaries: recall in [0,1]. Classification: 1 or 0. */
  score: number;
  /** True when a must-not-appear probe appeared (summaries only). */
  invented?: boolean;
}

// ── text matching (number aware) ────────────────────────────────────────────────────────────────────────────────────────
/** Lower-case, collapse whitespace, drop thousands separators inside numbers ("1,200" -> "1200"), unify quotes/dashes. */
export function normalise(text: string): string {
  let t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
  let prev: string;
  do { prev = t; t = t.replace(/(\d),(\d{3})(?!\d)/g, "$1$2"); } while (t !== prev);
  return t.replace(/\s+/g, " ");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` contain `needle`? Case-insensitive; a needle must not start in the middle of a word ("Mira" is not in "admiration") and one
 *  that starts or ends with a digit must not sit inside a longer number ("38" is not in "380" or "38.5", "12" is not in "2012"). A suffix
 *  after a word is allowed ("pause" matches "paused"). */
export function containsFact(text: string, needle: string): boolean {
  const n = normalise(needle).trim();
  if (!n) return false;
  const left = /^\d/.test(n) ? "(?<![a-z0-9])(?<!\\d\\.)" : /^[a-z]/.test(n) ? "(?<![a-z0-9])" : "";
  const right = /\d$/.test(n) ? "(?!\\d|\\.\\d)" : "";
  return new RegExp(`${left}${escapeRe(n)}${right}`).test(normalise(text));
}

const alternatives = (f: Fact): readonly string[] => (typeof f === "string" ? [f] : f);
const label = (f: Fact): string => alternatives(f).join(" | ");
export const hasFact = (text: string, f: Fact): boolean => alternatives(f).some((a) => containsFact(text, a));

// ── summaries ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export function scoreSummary(c: SummaryCase, text: string): CaseResult {
  const reasons: string[] = [];
  const base = { id: c.id, task: c.task } as const;
  const t = (text ?? "").trim();
  if (t.startsWith(ECHO_PREFIX)) {
    return { ...base, status: "invalid", reasons: ["echo fallback: the gateway had no provider key, this is not a model answer"], score: 0 };
  }
  if (t.length < SUMMARY_MIN_CHARS) reasons.push(`too short: ${t.length} chars (min ${SUMMARY_MIN_CHARS})${t ? `, got "${t.slice(0, 80)}"` : " (empty)"}`);
  const max = c.kind === "compaction" ? COMPACTION_SUMMARY_MAX_CHARS : HUB_SUMMARY_MAX_CHARS;
  if (t.length > max) reasons.push(`too long: ${t.length} chars (max ${max} for ${c.kind})`);

  const missing = c.mustKeep.filter((f) => !hasFact(t, f));
  const recall = c.mustKeep.length === 0 ? 1 : (c.mustKeep.length - missing.length) / c.mustKeep.length;
  if (recall < SUMMARY_MIN_RECALL) {
    reasons.push(`recall ${recall.toFixed(2)} < ${SUMMARY_MIN_RECALL}: missing ${missing.map((f) => `"${label(f)}"`).join(", ")}`);
  }
  const invented = c.mustNotAppear.filter((f) => hasFact(t, f));
  if (invented.length > 0) reasons.push(`INVENTED fact(s) not in the source: ${invented.map((f) => `"${label(f)}"`).join(", ")}`);

  return { ...base, status: reasons.length === 0 ? "pass" : "fail", reasons, score: recall, ...(invented.length > 0 ? { invented: true } : {}) };
}

// ── classification ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Score one classification answer with the REAL parser of the prompt it came from. */
export function scoreClassification(c: ClassifyCase, text: string): CaseResult {
  const base = { id: c.id, task: c.task } as const;
  const t = (text ?? "").trim();
  if (t.startsWith(ECHO_PREFIX)) {
    return { ...base, status: "invalid", reasons: ["echo fallback: the gateway had no provider key, this is not a model answer"], score: 0 };
  }
  const fail = (reason: string): CaseResult => ({ ...base, status: "fail", reasons: [reason], score: 0 });

  if (c.kind === "social") {
    const parsed = parseSocialTriage(t);
    if (!parsed.result) return fail(`real parser rejected the answer (not strict JSON or a label outside the accepted set): "${t.slice(0, 120)}"`);
    const diffs = (["sentiment", "category", "urgency"] as const)
      .filter((k) => parsed.result![k] !== c.expected[k])
      .map((k) => `${k}: expected ${c.expected[k]}, got ${parsed.result![k]}`);
    return diffs.length === 0 ? { ...base, status: "pass", reasons: [], score: 1 } : fail(`wrong label: ${diffs.join("; ")}`);
  }

  const parsed = parseAuditTriage(t, c.findings);
  if (parsed.draftedVia !== "ai") return fail(`real parser rejected the answer (fallback used; not strict JSON or no usable fixes): "${t.slice(0, 120)}"`);
  const got = new Set(parsed.draft.fixes.map((f) => f.code));
  const missing = c.expectedFixCodes.filter((code) => !got.has(code));
  const reasons: string[] = [];
  if (missing.length > 0) reasons.push(`fixes missing for: ${missing.join(", ")} (got ${[...got].join(", ") || "none"})`);
  if (!containsFact(parsed.draft.summary, c.priorityCode)) reasons.push(`summary does not name the first priority ${c.priorityCode}`);
  return reasons.length === 0 ? { ...base, status: "pass", reasons: [], score: 1 } : { ...base, status: "fail", reasons, score: 0 };
}

export function scoreCase(c: EvalCase, text: string): CaseResult {
  return c.task === "summarise" ? scoreSummary(c, text) : scoreClassification(c, text);
}

// ── verdicts ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ClassVerdict { verdict: Verdict; passed: number; total: number; rate: number; reason: string }

/** The verdict of ONE task class on ONE tier from its case results. Any invalid case (tier not applied, echo, call failed) makes the whole
 *  class INVALID: an unproven class is never a pass. */
export function classVerdict(task: TaskClass, results: readonly CaseResult[]): ClassVerdict {
  const total = results.length;
  const passed = results.filter((r) => r.status === "pass").length;
  const rate = total === 0 ? 0 : passed / total;
  const invalid = results.filter((r) => r.status === "invalid");
  if (total === 0) return { verdict: "INVALID", passed, total, rate, reason: "no cases ran" };
  if (invalid.length > 0) return { verdict: "INVALID", passed, total, rate, reason: `${invalid.length} invalid case(s): ${invalid.map((r) => r.id).join(", ")}` };
  if (task === "summarise") {
    const invented = results.filter((r) => r.invented).map((r) => r.id);
    if (invented.length > 0) return { verdict: "FAIL", passed, total, rate, reason: `invented fact in ${invented.join(", ")}` };
    return rate >= SUMMARISE_MIN_PASS_RATE
      ? { verdict: "PASS", passed, total, rate, reason: `${passed}/${total} cases pass (>= ${SUMMARISE_MIN_PASS_RATE})` }
      : { verdict: "FAIL", passed, total, rate, reason: `${passed}/${total} cases pass (< ${SUMMARISE_MIN_PASS_RATE})` };
  }
  return rate >= CLASSIFY_MIN_ACCURACY
    ? { verdict: "PASS", passed, total, rate, reason: `accuracy ${rate.toFixed(2)} >= ${CLASSIFY_MIN_ACCURACY}` }
    : { verdict: "FAIL", passed, total, rate, reason: `accuracy ${rate.toFixed(2)} < ${CLASSIFY_MIN_ACCURACY}` };
}

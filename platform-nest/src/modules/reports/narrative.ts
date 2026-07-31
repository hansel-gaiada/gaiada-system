// TR-27 — AI narrative for `ReportDocument` (§9.1, §15's TR-22 note: "TR-27 upgrades that same
// function [sealPeriod] without changing this contract"). Copies the `search/ai-drafts.ts`
// pattern EXACTLY — read that file's header before touching this one:
//
//   - PURE prompt-build + parse, ZERO I/O of its own. report-seal.ts's `sealPeriod` owns the ONE
//     `completeViaGateway` call (via `../search/providers/gateway-client.ts` — the only sanctioned
//     AI egress path, never a direct vendor call) inside a try/catch, exactly the way
//     search.controller.ts calls `parseTriageDraft`/`parseBriefDraft`: this file only ever sees
//     the completion text (or null, on any gateway failure) that its caller already resolved.
//   - NEVER THROWS. Every path below — gateway unconfigured/down/timeout (raw===null), an empty
//     completion, an over-length completion, or a completion carrying a numeral not present in the
//     grounding facts — downgrades to the CALLER-SUPPLIED deterministic fallback. That fallback is
//     `document-builder.ts`'s own `buildNarrative(kpis)` output for the SAME document: this file
//     never re-derives a second, subtly-different deterministic template. `document-builder.ts`
//     itself is untouched by this ticket (see report-seal.ts's header for why: the live path must
//     make ZERO gateway calls, so AI narration is layered on ONLY inside `sealPeriod`, never in
//     `buildReportDocument`).
//   - NEVER lets the model's own output pick an id, a status, a metric key or a scope. The model's
//     entire job is prose about numbers that are already pinned by the caller; nothing it emits
//     selects which kpi/highlight/series is real, only whether its OWN sentence is trustworthy
//     enough to keep (the numeral guard below).
//
// ─────────────────────────────── §11 PRIVACY — what the prompt is allowed to see ──────────────
// `buildGroundingFacts` extracts ONLY numbers/labels that already sit in the SAME `ReportDocument`
// the subject/manager can already read on screen (kpis' value/numerator/denominator/delta, a
// handful of series deltas, and the highlights' own already-deterministic text) — never
// check-in free text, task titles, or comment bodies (none of those fields even exist on a
// `ReportDocument`; this file only ever sees the same field set the chart viewer renders, §11
// principle 2 "transparency symmetric": nothing about the subject reaches the model that the
// subject cannot already see rendered on their own document).
//
// PERSON-GRAIN IS THE SENSITIVE CASE (§11): for a person-grain document the prompt contains
// exactly one person's own aggregate KPI-tile numbers (tasks completed, on-time rate, minutes
// logged, overdue-open count, source-diversity count) plus their deterministic highlight
// sentences and their display name + period label — nothing else. No keystrokes, no timelines, no
// message contents (§11's collected-set has no seam for any of those regardless of grain).
//
// The gateway (ai-gateway-go) is relied on for DLP + egress audit, per §11 principle 6 — this file
// does not reimplement either, and must never bypass them (no vendor SDK, no direct HTTP call).
//
// ─────────────────────────────── THE HALLUCINATED-NUMERAL GUARD (this ticket's sharpest bar) ──
// The narrative is prose ABOUT numbers that appear elsewhere in the same document (kpi tiles,
// series). Any numeral the model emits that is not already present in the grounding facts
// invalidates the WHOLE narrative — never a partial edit, never a "best effort" repair of the
// offending sentence — because a narrative that misquotes a number is worse than no narrative: it
// gets quoted in a management meeting as though it were the document's own number.
import { createHash } from "node:crypto";
import type { ReportDocument, ReportNarrative } from "./report-document";

/** §9.1 "Output guards: length cap". A narrative this file accepts is a short prose paragraph,
 *  not a report of its own — anything longer than this is treated the same as a parse failure. */
export const MAX_NARRATIVE_CHARS = 900;

export interface NarrativeKpiFact {
  metricKey: string;
  label: string;
  value: number;
  numerator?: number;
  denominator?: number;
  delta?: number;
}

export interface NarrativeSeriesDeltaFact {
  label: string;
  delta: number;
}

/** Everything the prompt is allowed to see, extracted from an ALREADY-BUILT `ReportDocument` — no
 *  second read of anything, no field the caller (sealPeriod) didn't already have in hand. §9.1:
 *  "embeds ONLY grounded facts (kpis with n/d, top series deltas, highlights)". */
export interface NarrativeGroundingFacts {
  scopeName: string;
  periodLabel: string;
  kpis: NarrativeKpiFact[];
  topSeriesDeltas: NarrativeSeriesDeltaFact[];
  highlights: string[];
}

const MAX_SERIES_DELTAS = 3;

/** Pure extraction — see the file header's §11 note on why this shape (and nothing wider) is what
 *  reaches the model. Deliberately excludes tables/distributions/raw series points/refs/ids: the
 *  prose is about SHAPE, not a second copy of the whole document. */
export function buildGroundingFacts(doc: ReportDocument): NarrativeGroundingFacts {
  const kpis: NarrativeKpiFact[] = doc.kpis.map((k) => ({
    metricKey: k.metricKey,
    label: k.label,
    value: k.value,
    ...(k.numerator !== undefined ? { numerator: k.numerator } : {}),
    ...(k.denominator !== undefined ? { denominator: k.denominator } : {}),
    ...(k.delta !== undefined ? { delta: k.delta } : {}),
  }));

  const topSeriesDeltas: NarrativeSeriesDeltaFact[] = doc.series
    .map((s): NarrativeSeriesDeltaFact | null => {
      const pts = s.points.filter((p): p is { t: string; v: number } => p.v !== null);
      if (pts.length < 2) return null;
      return { label: s.label, delta: pts[pts.length - 1].v - pts[0].v };
    })
    .filter((x): x is NarrativeSeriesDeltaFact => x !== null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_SERIES_DELTAS);

  return {
    scopeName: doc.header.scopeName,
    periodLabel: doc.header.periodLabel,
    kpis,
    topSeriesDeltas,
    highlights: doc.highlights.map((h) => h.text),
  };
}

/** Deep-canonical stringify (object keys sorted, array order preserved) — same technique
 *  report-seal.ts's `computeSealHash` uses, kept as an independent copy here deliberately: that
 *  one hashes a whole SEALED-DOCUMENT SET for tamper evidence (a different job, a different input
 *  shape); this one hashes the much smaller grounding-fact payload for narrative PROVENANCE
 *  ("`groundingHash` is stored, so a narrative can be traced to the exact facts it was generated
 *  from"). No cross-file coupling is needed for two different jobs. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the exact facts a prompt was (or would be) built from — stored on EVERY narrative,
 *  AI or deterministic, so a later audit can trace a fallback narrative's grounding too, not only
 *  an AI one. */
export function groundingHash(facts: NarrativeGroundingFacts): string {
  return createHash("sha256").update(canonicalStringify(facts)).digest("hex");
}

/** Build the Hermes narrative prompt for a `ReportDocument` — pure, embeds ONLY the grounding
 *  facts + house tone rules (§9.1). Free-text output (prose, not strict JSON) — same shape as
 *  `search/ai-drafts.ts`'s `buildReportNarrativePrompt`, but deliberately a SEPARATE function: that
 *  one narrates an SEO/SEM engagement report (rankings, findings); this one narrates a
 *  person/project/department/company WORK report (tasks, on-time rate, minutes) — different
 *  vocabulary, different document, no shared contract to preserve. */
export function buildNarrativePrompt(facts: NarrativeGroundingFacts): string {
  const lines = [
    `You are writing the short narrative paragraph of a work report for "${facts.scopeName}", period ${facts.periodLabel}.`,
    "House tone: plain, factual, third person, no hype, no speculation, no advice, no recommendations.",
    "Numbers you may reference (do not invent, round, or restate any number not listed here):",
    ...facts.kpis.map((k) => {
      const nd = k.numerator !== undefined && k.denominator !== undefined ? ` (${k.numerator} of ${k.denominator})` : "";
      const delta = k.delta !== undefined ? `, change ${k.delta} vs the prior period` : "";
      return `- ${k.label}: ${k.value}${nd}${delta}`;
    }),
    ...facts.topSeriesDeltas.map((s) => `- ${s.label} moved ${s.delta} over the period`),
    facts.highlights.length > 0 ? `Noted highlights: ${facts.highlights.join(" ")}` : "",
    `Write 1-2 short sentences (max ${MAX_NARRATIVE_CHARS} characters total) summarizing this period using ONLY the numbers listed above.`,
    "Reply with the plain-prose narrative only — no markdown, no headings, no JSON, no preamble.",
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

/** Normalizes a matched numeral string the same way on both sides of the guard: strips
 *  thousands-separator commas, then re-renders through `Number` so "12", "12.0" and "12.00" all
 *  collapse to the identical key ("a number is a number" — the guard is about VALUE identity, not
 *  string formatting). Non-finite input (should be unreachable given the regex) is returned
 *  unchanged so the guard fails closed (an unnormalizable token can never accidentally match). */
function normalizeNumeral(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
}

const NUMERAL_PATTERN = /\d[\d,]*(?:\.\d+)?/g;

/** Every numeral appearing in free text, normalized (see `normalizeNumeral`). Deliberately loose
 *  on what counts as "a numeral" (a percent sign or currency symbol adjacent to the digits does
 *  not change the extracted value) — the guard cares about the VALUE the model wrote, not its
 *  surrounding punctuation. */
function extractNumerals(text: string): string[] {
  const matches = text.match(NUMERAL_PATTERN) ?? [];
  return matches.map(normalizeNumeral);
}

/** Every numeral the grounding facts themselves make legitimate: kpi value/numerator/denominator/
 *  delta (and its absolute value, so a model writing "declined by 12" against a delta of -12
 *  passes), any numeral already embedded in a series-delta or a highlight's own deterministic
 *  text, and any numeral in the scope name / period label (both already rendered elsewhere on the
 *  same document's header — repeating "16 Jul 2026"'s "2026" back is not a hallucination). */
function allowedNumerals(facts: NarrativeGroundingFacts): Set<string> {
  const out = new Set<string>();
  const add = (n: number | undefined) => {
    if (n === undefined || !Number.isFinite(n)) return;
    out.add(normalizeNumeral(String(n)));
  };
  for (const k of facts.kpis) {
    add(k.value);
    add(k.numerator);
    add(k.denominator);
    add(k.delta);
    if (k.delta !== undefined) add(Math.abs(k.delta));
  }
  for (const s of facts.topSeriesDeltas) {
    add(s.delta);
    add(Math.abs(s.delta));
  }
  for (const text of [...facts.highlights, facts.scopeName, facts.periodLabel]) {
    for (const n of extractNumerals(text)) out.add(n);
  }
  return out;
}

/** THE HALLUCINATED-NUMERAL GUARD (file header). True only if EVERY numeral appearing in `text`
 *  is already a legitimate grounding-fact numeral. A narrative with no numerals at all trivially
 *  passes (it cannot misquote a number it never states). Exported standalone so it can be pinned
 *  by a test independent of the full `parseNarrative` fallback wiring. */
export function passesNumeralGuard(text: string, facts: NarrativeGroundingFacts): boolean {
  const allowed = allowedNumerals(facts);
  return extractNumerals(text).every((n) => allowed.has(n));
}

/** Parse ai-gateway-go's `/complete` response for a document narrative. NEVER throws (file
 *  header). `raw` is null exactly when the CALLER's `completeViaGateway` call itself failed
 *  (unconfigured gateway, timeout, non-2xx) — this file is never the one making that call, so it
 *  never has anything to catch; it only ever branches on what it was handed.
 *
 *  `fallback` is the ALREADY-COMPUTED deterministic `ReportNarrative` for this SAME document
 *  (`document-builder.ts`'s `buildNarrative(kpis)` output, passed through by `sealPeriod`
 *  unchanged) — this file never re-derives its own deterministic template; "without changing this
 *  contract" (§15's TR-22 note) means TR-13's fallback wording is reused byte-for-byte, every time,
 *  never a second, subtly-different deterministic phrasing living in two places. */
export function parseNarrative(raw: string | null, model: string | null, facts: NarrativeGroundingFacts, fallback: ReportNarrative): ReportNarrative {
  const hash = groundingHash(facts);
  const trimmed = raw?.trim() ?? "";
  const withinLengthCap = trimmed.length > 0 && trimmed.length <= MAX_NARRATIVE_CHARS;
  if (withinLengthCap && passesNumeralGuard(trimmed, facts)) {
    return { source: "ai", text: trimmed, ...(model ? { model } : {}), groundingHash: hash };
  }
  // Fail-soft (every branch above that didn't return lands here): empty/whitespace completion,
  // over-length, or a numeral the guard rejected. `source` is honestly forced to "deterministic"
  // regardless of what `fallback.source` already said (it always already says so, from
  // `document-builder.ts` — restated here so this function's own output contract does not
  // silently depend on the caller having gotten that right, per the standing ruling that every
  // fallback path must fail CLOSED and be labelled, never mistakable for the real thing).
  return { ...fallback, source: "deterministic", groundingHash: hash };
}

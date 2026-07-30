// SM-10 — AI drafting services: content briefs, audit-finding triage/fix drafts (which also cover
// "meta/title/on-page suggestions" — see migration 0046's header for why those share one column),
// and report-narrative drafts (design §07/§12 SM-10: "Drafts persist as rows/files; zero direct
// vendor calls (gateway asserted in tests); knowledge ingest ACL-scoped").
//
// Pure/testable split (mirrors search-audit.ts + clustering.ts): this file only builds prompts and
// parses ai-gateway-go /complete responses. search.controller.ts owns every DB read/write and the
// (optional) WS8 knowledge round trip (knowledge-client.ts) — this file makes no I/O of its own.
//
// FAIL-SOFT PARSING (MUST HOLD, design §07 "AI-drafts -> human-approves"): every parse* function
// below NEVER throws, and never lets the AI's own output pick an id or a status value:
//   - parseBriefDraft / parseTriageDraft tolerate surrounding prose (first balanced-looking `{...}`,
//     same technique as clustering.ts's parseClusterLabel) and fall back to a DETERMINISTIC template
//     built from the grounding facts alone when parsing fails or the gateway throws — a brief/triage
//     draft is never lost just because Hermes hiccuped, mirroring clusterKeywordSet's fail-soft label
//     fallback (a cluster is never dropped for want of a label).
//   - parseTriageDraft additionally DROPS any fix-suggestion whose `code` is not one of the finding
//     codes the caller already fetched for THIS audit (`knownCodes`) — the AI's own text can never
//     cause a write to a finding this request didn't already have in scope. search.controller.ts
//     applies a second, independent enforcement of the same rule at the SQL layer (`WHERE audit_id =
//     $1 AND code = $2`, both parameterized, never string-built from AI output).
export const MAX_BRIEF_FINDINGS = 50;
export const MAX_BRIEF_KEYWORDS = 200;
export const MAX_TRIAGE_FINDINGS = 30;
export const MAX_KNOWLEDGE_HITS = 8;
// Separate, SMALLER bound than MAX_BRIEF_FINDINGS: the knowledge service embeds each ingested chunk
// with its OWN sequential per-chunk gateway call before /ingest returns (ai-agents/src/knowledge/
// store.ts's ingest loop) — a purely-local prompt-context bound (MAX_BRIEF_FINDINGS) is not a safe
// stand-in for "how many chunks am I asking a DIFFERENT service to embed on my behalf", so this is
// its own explicit, smaller cap.
export const MAX_KNOWLEDGE_INGEST_CHUNKS = 16;

// ─────────────────────────────────────────────── Content briefs ───────────────────────────────────
export interface BriefFindingFact {
  code: string;
  severity: string;
  category: string | null;
  message: string;
}
export interface BriefKeywordFact {
  keyword: string;
  intent: string | null;
  clusterLabel: string | null;
}
export interface BriefKnowledgeHit {
  sourceRef: string;
  text: string;
  score: number;
}
export interface BriefGroundingFacts {
  propertyDomain: string;
  findings: BriefFindingFact[];
  keywords: BriefKeywordFact[];
  knowledgeHits: BriefKnowledgeHit[];
}

export interface BriefDraft {
  outline: string[];
  body: string;
  geoNotes: string;
}

/** Build the Hermes brief-drafting prompt. Strict-JSON output request (same technique as
 *  clustering.ts's buildClusterPrompt) so parseBriefDraft has a reliable shape to parse. */
export function buildBriefPrompt(topic: string, facts: BriefGroundingFacts): string {
  const lines = [
    "You are drafting a content brief for an SEO/GEO content writer.",
    `Property: ${facts.propertyDomain}`,
    `Topic: ${topic}`,
  ];
  if (facts.findings.length > 0) {
    lines.push(
      `Open technical/content findings on this property: ${facts.findings
        .map((f) => `${f.severity}/${f.code} (${f.message})`)
        .join("; ")}`,
    );
  }
  if (facts.keywords.length > 0) {
    lines.push(
      `Target keywords (with intent/cluster where known): ${facts.keywords
        .map((k) => `${k.keyword}${k.intent ? ` [${k.intent}]` : ""}${k.clusterLabel ? ` (${k.clusterLabel})` : ""}`)
        .join(", ")}`,
    );
  }
  if (facts.knowledgeHits.length > 0) {
    lines.push(
      `Relevant excerpts already crawled from this property:\n${facts.knowledgeHits
        .map((h) => `- (${h.sourceRef}) ${h.text}`)
        .join("\n")}`,
    );
  }
  lines.push(
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      '{"outline": ["<section heading>", ...], "body": "<a short draft in markdown>", ' +
      '"geoNotes": "<GEO/AEO extractability guidance: structure/citability advice for AI-answer engines>"}',
  );
  return lines.join("\n");
}

function fallbackBriefDraft(topic: string, facts: BriefGroundingFacts): BriefDraft {
  const outline = [
    `Introduction: ${topic}`,
    ...facts.keywords.slice(0, 5).map((k) => `Cover: ${k.keyword}`),
    ...(facts.findings.length > 0 ? ["Address open technical/content findings"] : []),
    "Conclusion / call to action",
  ];
  const body = [
    `Draft brief for "${topic}" on ${facts.propertyDomain} (AI drafting unavailable — deterministic outline only).`,
    facts.findings.length > 0
      ? `Open findings to address: ${facts.findings.map((f) => f.code).join(", ")}.`
      : "",
    facts.keywords.length > 0
      ? `Target keywords: ${facts.keywords.slice(0, 20).map((k) => k.keyword).join(", ")}.`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  return { outline, body, geoNotes: "" };
}

export interface BriefDraftResult {
  draft: BriefDraft;
  draftedVia: "ai" | "fallback";
}

/** Parse Hermes's /complete response for a brief draft. NEVER throws — see file header. */
export function parseBriefDraft(raw: string | null, topic: string, facts: BriefGroundingFacts): BriefDraftResult {
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { outline?: unknown; body?: unknown; geoNotes?: unknown };
        const outline = Array.isArray(parsed.outline) ? parsed.outline.filter((x): x is string => typeof x === "string") : [];
        const body = typeof parsed.body === "string" ? parsed.body : "";
        const geoNotes = typeof parsed.geoNotes === "string" ? parsed.geoNotes : "";
        if (outline.length > 0 || body.trim().length > 0) {
          return { draft: { outline, body, geoNotes }, draftedVia: "ai" };
        }
      } catch {
        /* malformed JSON -> fall through to the deterministic default below */
      }
    }
  }
  return { draft: fallbackBriefDraft(topic, facts), draftedVia: "fallback" };
}

/** Build the (optional) "polish this draft" follow-up prompt (design §07/§08: "Polish brief/content
 *  with Claude" — the gateway's OWN chain decides which provider actually serves this call; this
 *  module has no provider-selection knob, see search.controller.ts's polish route for the honest
 *  accounting of that gap). Reuses the same strict-JSON contract as the initial draft so
 *  parseBriefDraft can parse either response identically. */
export function buildBriefPolishPrompt(draft: BriefDraft): string {
  return [
    "Polish and tighten the following content-brief draft for clarity, flow and SEO/GEO best",
    "practice. Keep the same sections; improve wording only, do not invent new facts.",
    `Current outline: ${JSON.stringify(draft.outline)}`,
    `Current body:\n${draft.body}`,
    `Current GEO notes: ${draft.geoNotes}`,
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      '{"outline": [...], "body": "...", "geoNotes": "..."}',
  ].join("\n");
}

// ────────────────────────────────────── Audit-finding triage + fix drafts ─────────────────────────
export interface TriageFindingFact {
  code: string;
  severity: string;
  category: string | null;
  message: string;
  urlCount: number;
}
export interface TriageFixDraft {
  code: string;
  suggestion: string;
}
export interface TriageDraft {
  summary: string;
  fixes: TriageFixDraft[];
}
export interface TriageDraftResult {
  draft: TriageDraft;
  draftedVia: "ai" | "fallback";
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

/** Build the Hermes finding-triage prompt: ONE call per ai-triage request covering every open
 *  finding passed in (bounded to MAX_TRIAGE_FINDINGS by the caller) — never one gateway call per
 *  finding (that would reintroduce the SM-32 unbounded-loop shape this module was explicitly told
 *  not to repeat). */
export function buildTriagePrompt(findings: TriageFindingFact[]): string {
  const lines = [
    "You are triaging technical SEO audit findings and drafting fix suggestions (including",
    "meta/title/on-page suggestions where the finding is about missing/duplicate titles or metadata).",
    "Findings:",
    ...findings.map((f) => `- [${f.code}] severity=${f.severity} category=${f.category ?? "n/a"} urls=${f.urlCount}: ${f.message}`),
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      '{"summary": "<prioritized overview of what to fix first and why>", ' +
      '"fixes": [{"code": "<one of the finding codes above, exactly>", "suggestion": "<concrete fix/meta suggestion>"}]}',
  ];
  return lines.join("\n");
}

function fallbackTriageDraft(findings: TriageFindingFact[]): TriageDraft {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const summary =
    `${findings.length} open finding(s) (AI drafting unavailable — deterministic summary only). ` +
    `Highest priority: ${sorted.slice(0, 5).map((f) => `${f.severity}/${f.code}`).join(", ") || "none"}.`;
  const fixes = sorted.map((f) => ({ code: f.code, suggestion: `Review and resolve: ${f.message}` }));
  return { summary, fixes };
}

/** Parse Hermes's /complete response for a triage draft. NEVER throws, and DROPS any fix whose code
 *  is not in `findings` (defense-in-depth — see file header; search.controller.ts enforces the same
 *  rule independently at the SQL layer). */
export function parseTriageDraft(raw: string | null, findings: TriageFindingFact[]): TriageDraftResult {
  const knownCodes = new Set(findings.map((f) => f.code));
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { summary?: unknown; fixes?: unknown };
        const summary = typeof parsed.summary === "string" ? parsed.summary : "";
        const fixesRaw = Array.isArray(parsed.fixes) ? parsed.fixes : [];
        const fixes: TriageFixDraft[] = fixesRaw
          .filter((f): f is { code?: unknown; suggestion?: unknown } => !!f && typeof f === "object")
          .map((f) => ({
            code: typeof f.code === "string" ? f.code : "",
            suggestion: typeof f.suggestion === "string" ? f.suggestion.trim() : "",
          }))
          .filter((f) => f.code.length > 0 && knownCodes.has(f.code) && f.suggestion.length > 0);
        if (summary.trim().length > 0 || fixes.length > 0) {
          return { draft: { summary: summary.trim(), fixes }, draftedVia: "ai" };
        }
      } catch {
        /* malformed JSON -> fall through to the deterministic default below */
      }
    }
  }
  return { draft: fallbackTriageDraft(findings), draftedVia: "fallback" };
}

// ───────────────────────────────────────────── Report narrative ───────────────────────────────────
export interface ReportKpiFact {
  metric: string;
  target: number;
  direction: string;
}
export interface ReportMetricsFacts {
  period: string;
  rankTop10: number;
  criticalFindingsOpen: number;
  kpiTargets: ReportKpiFact[];
}
export interface ReportNarrativeResult {
  narrative: string;
  draftedVia: "ai" | "fallback";
}

/** Build the Hermes report-narrative prompt (design §07: "Report narrative | Hermes draft -> Claude
 *  polish..." — SM-10 delivers the Hermes-draft function; SM-22 owns the review/approve/render/
 *  deliver flow + the client-facing Claude-polish default around it). Free-text output (no strict
 *  JSON contract needed here, unlike briefs/triage) — narrative_md is markdown prose. */
export function buildReportNarrativePrompt(engagementName: string, facts: ReportMetricsFacts): string {
  return [
    `You are drafting the narrative section of a monthly SEO/SEM report for "${engagementName}", period ${facts.period}.`,
    `Keywords currently ranking top-10: ${facts.rankTop10}.`,
    `Open critical audit findings: ${facts.criticalFindingsOpen}.`,
    facts.kpiTargets.length > 0
      ? `KPI targets: ${facts.kpiTargets.map((k) => `${k.metric} target ${k.target} (${k.direction})`).join("; ")}.`
      : "",
    "Write a short (3-5 paragraph) markdown narrative summarizing progress, wins, risks and next",
    "steps for this engagement based on the numbers above. Reply with the markdown narrative only,",
    "no JSON, no preamble.",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

function fallbackReportNarrative(facts: ReportMetricsFacts): string {
  return [
    `## ${facts.period} summary (AI drafting unavailable — auto-generated summary only)`,
    `- Keywords ranking top-10: ${facts.rankTop10}`,
    `- Open critical audit findings: ${facts.criticalFindingsOpen}`,
    facts.kpiTargets.length > 0
      ? `- KPI targets: ${facts.kpiTargets.map((k) => `${k.metric} → ${k.target} (${k.direction})`).join(", ")}`
      : "",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Parse Hermes's /complete response for a report narrative. NEVER throws. Free text, so "parsing"
 *  is just a non-empty check; an empty/whitespace-only completion (or a thrown/unreachable gateway,
 *  handled by the caller's try/catch before this is ever invoked with null) falls back to a
 *  deterministic templated summary, same fail-soft contract as the brief/triage drafts above. */
export function parseReportNarrative(raw: string | null, facts: ReportMetricsFacts): ReportNarrativeResult {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length > 0) return { narrative: trimmed, draftedVia: "ai" };
  return { narrative: fallbackReportNarrative(facts), draftedVia: "fallback" };
}

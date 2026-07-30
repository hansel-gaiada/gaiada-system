// SM-18 — SEM AI drafts: RSA (responsive search ad) headline/description drafts and negative-keyword
// classification (design §07/§12 SM-18: "RSA + negative AI drafts"; §07's task→model table: "Search-
// term → negative classification | Hermes + rules | ... | Output = search_negatives(status=
// 'proposed')" and "RSA ad copy | Hermes draft → Claude final for approved launches | Ads Studio |
// Drafts never auto-publish"). Pure/testable split mirrors ai-drafts.ts exactly: this file only
// builds prompts and parses ai-gateway-go /complete responses; search.controller.ts owns every DB
// read/write and the (single, non-looped) completeViaGateway call.
//
// FAIL-SOFT PARSING (MUST HOLD, same contract as ai-drafts.ts's file header): parse* functions below
// NEVER throw. An AI hiccup degrades to a deterministic fallback rather than losing the request —
// EXCEPT that a negatives proposal's fallback is deliberately EMPTY (see parseNegativesProposal's
// doc comment for why "propose nothing" is the honest fallback here, unlike triage/brief drafts).
//
// SM-32 lesson (this program's standing lesson, restated so it cannot regress here): every draft in
// this file is built from ONE completeViaGateway call covering the whole ad group / whole submitted
// term list — never one gateway call per keyword or per term. Both call sites in the controller must
// keep that shape.
export const MAX_RSA_KEYWORDS = 30;
export const MAX_RSA_HEADLINES = 15;
export const MAX_RSA_DESCRIPTIONS = 4;
export const RSA_HEADLINE_MAX_CHARS = 30;
export const RSA_DESCRIPTION_MAX_CHARS = 90;
// Google Ads' own minimums for an RSA to be eligible; below this the draft is not a usable ad, so
// parseRsaDraft treats an AI response short of these as "nothing usable" and falls back.
const MIN_RSA_HEADLINES = 3;
const MIN_RSA_DESCRIPTIONS = 2;

export const MAX_NEGATIVE_TERMS = 200;
export const NEGATIVE_MATCH_TYPES = ["broad", "phrase", "exact"] as const;
export type NegativeMatchType = (typeof NEGATIVE_MATCH_TYPES)[number];

// ─────────────────────────────────────────────────── RSA drafts ───────────────────────────────────
export interface RsaKeywordFact {
  keyword: string;
  intent: string | null;
}

export interface RsaDraft {
  headlines: string[];
  descriptions: string[];
}

export interface RsaDraftResult {
  draft: RsaDraft;
  draftedVia: "ai" | "fallback";
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max).trim();
}

/** Build the Hermes RSA-drafting prompt (design §07/§08: "Generate RSA drafts | Planner/Ads Studio |
 *  🟢 | draft only"). Strict-JSON output request, same technique as clustering.ts/ai-drafts.ts. */
export function buildRsaDraftPrompt(adGroupName: string, finalUrl: string | null, keywords: RsaKeywordFact[]): string {
  const lines = [
    "You are drafting a Google Ads Responsive Search Ad (RSA) for the following ad group.",
    `Ad group: ${adGroupName}`,
    finalUrl ? `Landing page: ${finalUrl}` : "",
    `Target keywords: ${keywords.map((k) => `${k.keyword}${k.intent ? ` [${k.intent}]` : ""}`).join(", ")}`,
    `Write between ${MIN_RSA_HEADLINES} and ${MAX_RSA_HEADLINES} headlines (max ${RSA_HEADLINE_MAX_CHARS} characters ` +
      `each) and between ${MIN_RSA_DESCRIPTIONS} and ${MAX_RSA_DESCRIPTIONS} descriptions (max ${RSA_DESCRIPTION_MAX_CHARS} ` +
      "characters each). Do not fabricate prices, guarantees or claims not implied by the keywords.",
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      '{"headlines": ["<headline>", ...], "descriptions": ["<description>", ...]}',
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

function fallbackRsaDraft(adGroupName: string, keywords: RsaKeywordFact[]): RsaDraft {
  const top = keywords.slice(0, MIN_RSA_HEADLINES).map((k) => k.keyword);
  const headlines = [
    truncate(adGroupName, RSA_HEADLINE_MAX_CHARS),
    ...top.map((k) => truncate(k, RSA_HEADLINE_MAX_CHARS)),
  ].filter((h, i, arr) => h.length > 0 && arr.indexOf(h) === i);
  while (headlines.length < MIN_RSA_HEADLINES) headlines.push(truncate(`Learn more about ${adGroupName}`, RSA_HEADLINE_MAX_CHARS));
  const descriptions = [
    truncate(`Explore ${adGroupName}. AI drafting unavailable — deterministic draft only.`, RSA_DESCRIPTION_MAX_CHARS),
    truncate(`Relevant to: ${keywords.slice(0, 5).map((k) => k.keyword).join(", ")}.`, RSA_DESCRIPTION_MAX_CHARS),
  ];
  return { headlines: headlines.slice(0, MAX_RSA_HEADLINES), descriptions: descriptions.slice(0, MAX_RSA_DESCRIPTIONS) };
}

/** Parse Hermes's /complete response for an RSA draft. NEVER throws — see file header. Truncates
 *  each line defensively to the platform's character limits (never rejects the whole draft for one
 *  over-length line) and REQUIRES at least MIN_RSA_HEADLINES/MIN_RSA_DESCRIPTIONS usable lines before
 *  accepting the AI's draft at all — anything short of that is "not a usable ad" and falls back to
 *  the deterministic draft rather than persisting a half-built one. */
export function parseRsaDraft(raw: string | null, adGroupName: string, keywords: RsaKeywordFact[]): RsaDraftResult {
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { headlines?: unknown; descriptions?: unknown };
        const headlines = (Array.isArray(parsed.headlines) ? parsed.headlines : [])
          .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
          .map((h) => truncate(h, RSA_HEADLINE_MAX_CHARS))
          .slice(0, MAX_RSA_HEADLINES);
        const descriptions = (Array.isArray(parsed.descriptions) ? parsed.descriptions : [])
          .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
          .map((d) => truncate(d, RSA_DESCRIPTION_MAX_CHARS))
          .slice(0, MAX_RSA_DESCRIPTIONS);
        if (headlines.length >= MIN_RSA_HEADLINES && descriptions.length >= MIN_RSA_DESCRIPTIONS) {
          return { draft: { headlines, descriptions }, draftedVia: "ai" };
        }
      } catch {
        /* malformed JSON -> fall through to the deterministic default below */
      }
    }
  }
  return { draft: fallbackRsaDraft(adGroupName, keywords), draftedVia: "fallback" };
}

// ─────────────────────────────────────────────── Negative-keyword drafts ──────────────────────────
export interface NegativeCandidate {
  term: string;
  matchType: NegativeMatchType;
  reason: string;
}

export interface NegativesProposalResult {
  candidates: NegativeCandidate[];
  draftedVia: "ai" | "fallback";
}

/** Build the Hermes negative-classification prompt (design §07: "Search-term → negative
 *  classification | Hermes + rules"). ONE call for the WHOLE submitted term list (SM-32 lesson —
 *  never one call per term). `terms` are human-submitted (paste/CSV, same shape as keyword import)
 *  since no live search-term sync exists yet in this ticket (that is SM-20's job) — a human is
 *  asking "which of these look like poor-fit traffic", not the ERP auto-sweeping live data. */
export function buildNegativesProposalPrompt(campaignName: string, terms: string[]): string {
  return [
    `You are reviewing search terms for the Google Ads campaign "${campaignName}" and proposing`,
    "NEGATIVE keyword candidates — terms that look like irrelevant, low-intent, or poor-fit traffic",
    "for this campaign (e.g. unrelated topics, free/DIY/job-seeking intent when the campaign sells a",
    "paid service, or terms for a clearly different product). Do not propose a term that looks like",
    "a genuinely relevant, in-intent search for this campaign.",
    `Search terms: ${terms.join(", ")}`,
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      '{"negatives": [{"term": "<one of the search terms above, EXACTLY>", ' +
      '"matchType": "broad|phrase|exact", "reason": "<short reason>"}]}',
  ].join("\n");
}

/** Parse Hermes's /complete response for a negatives proposal. NEVER throws, and DROPS any candidate
 *  whose `term` is not an exact (case-insensitive) match to one of the SUBMITTED `knownTerms` — the
 *  AI's own text can never invent a negative-keyword row for a term this request didn't submit
 *  (defense in depth; search.controller.ts enforces the same rule independently by only ever
 *  inserting from the returned candidate list, never from raw AI text).
 *
 *  The fallback is deliberately EMPTY, unlike ai-drafts.ts's triage/brief fallbacks: a missed
 *  negative-keyword suggestion costs nothing (the human reviews the term list manually and still
 *  loses no traffic-control ability), whereas a FABRICATED rule-based "this looks bad" judgment
 *  presented with the same confidence as an AI read would be a wrong answer wearing the costume of
 *  a right one — worse than returning nothing. */
export function parseNegativesProposal(raw: string | null, knownTerms: string[]): NegativesProposalResult {
  const known = new Map(knownTerms.map((t) => [t.trim().toLowerCase(), t]));
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { negatives?: unknown };
        const raw2 = Array.isArray(parsed.negatives) ? parsed.negatives : [];
        const seen = new Set<string>();
        const candidates: NegativeCandidate[] = raw2
          .filter((n): n is { term?: unknown; matchType?: unknown; reason?: unknown } => !!n && typeof n === "object")
          .map((n) => {
            const termKey = typeof n.term === "string" ? n.term.trim().toLowerCase() : "";
            const canonicalTerm = known.get(termKey);
            const matchType = NEGATIVE_MATCH_TYPES.includes(n.matchType as NegativeMatchType)
              ? (n.matchType as NegativeMatchType)
              : "exact";
            const reason = typeof n.reason === "string" ? n.reason.trim().slice(0, 500) : "";
            return canonicalTerm ? { term: canonicalTerm, matchType, reason } : null;
          })
          .filter((c): c is NegativeCandidate => {
            if (!c) return false;
            const key = c.term.toLowerCase();
            if (seen.has(key)) return false; // dedupe a repeated term from the AI's own output
            seen.add(key);
            return true;
          });
        if (candidates.length > 0) return { candidates, draftedVia: "ai" };
      } catch {
        /* malformed JSON -> fall through to the empty fallback below */
      }
    }
  }
  return { candidates: [], draftedVia: "fallback" };
}

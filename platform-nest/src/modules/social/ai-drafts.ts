// SMM-19 — brand-voice drafting: caption/hashtag copy for one network variant, and content-idea
// generation for a post calendar. Design smm-design.md §07 ("Caption/copy drafting" + "Hashtag
// generation" + "Content ideas") as amended by smm-design-addendum-2026-08-12.md (D-13: the corpus
// lives in WS8 knowledge; D-17: no image path — this file never produces or requests one).
//
// Pure/testable split (mirrors search/ai-drafts.ts exactly): this file only builds prompts and
// parses ai-gateway-go /complete responses. social.controller.ts owns every DB read/write and the
// (optional) WS8 knowledge round trip (knowledge-client.ts) — this file makes no I/O of its own.
//
// FAIL-SOFT PARSING (MUST HOLD, design §07 "AI-drafts -> human-approves"): every parse* function
// below NEVER throws, and never lets the AI's own output pick a status value or exceed a limit the
// PLATFORM owns:
//   - parseCaptionDraft tolerates surrounding prose (first balanced-looking `{...}`) and falls back
//     to a deterministic template built from the grounding facts alone when parsing fails or the
//     gateway throws — a caption draft is never lost just because Hermes hiccuped.
//   - Hashtags are ALWAYS re-derived through applyHashtagStrategy(), which is the ONE place the
//     brand's hashtag_strategy and the network's own cap (media-rules.ts's maxHashtagsFor —
//     REUSED, never a second table of limits) are enforced. The AI's own count is advisory input,
//     never the final answer: a caller cannot get more hashtags out of this file than the network
//     and the brand strategy jointly allow, no matter what the model returns.
//   - parseIdeaDraft caps the returned idea count at the CALLER's requested `count` (never the AI's
//     own idea of how many to produce), and drops any idea with an empty title.
import { type Network, maxHashtagsFor, supportsFirstCommentFor } from "./media-rules";

export const MAX_KNOWLEDGE_HITS = 8;
// Mirrors search/ai-drafts.ts's MAX_KNOWLEDGE_INGEST_CHUNKS reasoning: the knowledge service embeds
// each ingested chunk with its OWN sequential per-chunk gateway call before /ingest returns
// (ai-agents/src/knowledge/store.ts), so this is its own explicit, smaller bound — a purely-local
// prompt-context bound is not a safe stand-in for "how many chunks am I asking a DIFFERENT service
// to embed on my behalf".
export const MAX_BRAND_INGEST_CHUNKS = 40;
export const MAX_IDEA_COUNT = 10;

// ───────────────────────────────────────────── Hashtag strategy ───────────────────────────────────
/** The (currently free-form jsonb) shape this file expects `social_brand_profiles.hashtag_strategy`
 *  to carry. Every field is optional and defaults to "no constraint beyond the network's own cap" —
 *  an engagement with no strategy configured yet must still draft something sane, never refuse. */
export interface HashtagStrategy {
  /** Additional cap on top of the network's own (the tighter of the two always wins). */
  maxCount?: number;
  /** Tags (with or without '#') that must never appear, regardless of what the model proposes. */
  bannedTags?: string[];
  /** Tags (with or without '#') that are always included, subject to the ban list and the cap. */
  requiredTags?: string[];
  /** Where hashtags land: appended to the body, or (Instagram-style) the first comment. Falls back
   *  to 'body' on a network with no first-comment surface, regardless of what the strategy asks. */
  placement?: "body" | "first_comment";
}

function sanitizeTag(raw: string): string {
  return raw.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").trim();
}

/** THE enforcement point (file header). Applies bans, dedupes case-insensitively, always includes
 *  required tags first (subject to the ban list — a tag that is both required and banned is a
 *  caller mistake, and banned wins: this file never posts something explicitly forbidden), then
 *  fills the remainder from the model's proposal, and finally caps at
 *  min(network's own cap, strategy.maxCount) — never either alone. */
export function applyHashtagStrategy(proposed: string[], network: Network, strategy: HashtagStrategy): string[] {
  const banned = new Set((strategy.bannedTags ?? []).map((t) => sanitizeTag(t).toLowerCase()).filter(Boolean));
  const required = (strategy.requiredTags ?? []).map(sanitizeTag).filter((t) => t.length > 0);
  const networkCap = maxHashtagsFor(network);
  const strategyCap = typeof strategy.maxCount === "number" && Number.isFinite(strategy.maxCount) && strategy.maxCount >= 0
    ? Math.floor(strategy.maxCount)
    : undefined;
  const caps = [networkCap, strategyCap].filter((n): n is number => n !== undefined);
  const cap = caps.length > 0 ? Math.min(...caps) : undefined;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...required, ...proposed.map(sanitizeTag)]) {
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (banned.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (cap !== undefined && out.length >= cap) break;
  }
  return out;
}

/** Where the strategy wants hashtags placed, clamped to what the network actually supports — a
 *  strategy asking for `first_comment` on a network with no such surface (media-rules.ts's
 *  supportsFirstCommentFor) silently falls back to `body` rather than refusing the whole draft. */
function effectivePlacement(network: Network, strategy: HashtagStrategy): "body" | "first_comment" {
  return strategy.placement === "first_comment" && supportsFirstCommentFor(network) ? "first_comment" : "body";
}

// ───────────────────────────────────────────── Caption drafting ───────────────────────────────────
export interface CaptionGroundingFacts {
  network: Network;
  engagementName: string;
  postBrief: string;
  /** Existing body text, if re-drafting — grounds the model in what's already there rather than
   *  starting from nothing. */
  existingBody: string;
  tone: Record<string, unknown>;
  hashtagStrategy: HashtagStrategy;
  knowledgeHits: Array<{ sourceRef: string; text: string }>;
}

export interface CaptionDraft {
  body: string;
  /** Sanitized, deduped, capped per applyHashtagStrategy — WITHOUT the leading '#'. */
  hashtags: string[];
  /** Non-null only when the network supports a first-comment surface AND the strategy asked for
   *  hashtags to land there. */
  firstComment: string | null;
}
export interface CaptionDraftResult {
  draft: CaptionDraft;
  draftedVia: "ai" | "fallback";
}

/** Build the Hermes/Claude caption-drafting prompt. Strict-JSON output request (same technique as
 *  search/ai-drafts.ts's buildBriefPrompt) so parseCaptionDraft has a reliable shape to parse. */
export function buildCaptionPrompt(facts: CaptionGroundingFacts): string {
  const lines = [
    `You are drafting a ${facts.network} caption for the brand behind "${facts.engagementName}".`,
    `Brief: ${facts.postBrief || "(no brief provided — use the brand voice and past posts alone)"}`,
  ];
  if (facts.existingBody.trim()) {
    lines.push(`Existing draft to improve on: ${facts.existingBody}`);
  }
  if (Object.keys(facts.tone).length > 0) {
    lines.push(`Brand voice / tone rules (JSON): ${JSON.stringify(facts.tone)}`);
  }
  if (facts.knowledgeHits.length > 0) {
    lines.push(
      `Excerpts from this brand's own approved past posts and guidelines:\n${facts.knowledgeHits
        .map((h) => `- (${h.sourceRef}) ${h.text}`)
        .join("\n")}`,
    );
  }
  lines.push(
    "Write in this brand's voice, consistent with the excerpts above where relevant. Do not invent",
    "claims, prices or promises not grounded in the brief or the excerpts. Never suggest generating",
    "or attaching an image — this system has no image-generation capability.",
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      '{"body": "<the caption text, no hashtags inline>", "hashtags": ["<tag without #>", ...]}',
  );
  return lines.join("\n");
}

function fallbackCaptionDraft(facts: CaptionGroundingFacts): CaptionDraft {
  const body = facts.existingBody.trim() || facts.postBrief.trim()
    || `Update from ${facts.engagementName || "us"} (AI drafting unavailable — placeholder only).`;
  const hashtags = applyHashtagStrategy(facts.hashtagStrategy.requiredTags ?? [], facts.network, facts.hashtagStrategy);
  const placement = effectivePlacement(facts.network, facts.hashtagStrategy);
  const tagText = hashtags.length > 0 ? hashtags.map((t) => `#${t}`).join(" ") : "";
  return {
    body: placement === "body" && tagText ? `${body}\n\n${tagText}` : body,
    hashtags,
    firstComment: placement === "first_comment" && tagText ? tagText : null,
  };
}

/** Parse the gateway's /complete response for a caption draft. NEVER throws — see file header.
 *  Hashtags in the parsed JSON are advisory input to applyHashtagStrategy(), never the final list. */
export function parseCaptionDraft(raw: string | null, facts: CaptionGroundingFacts): CaptionDraftResult {
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { body?: unknown; hashtags?: unknown };
        const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
        const proposedTags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((x): x is string => typeof x === "string") : [];
        if (body.length > 0 || proposedTags.length > 0) {
          const hashtags = applyHashtagStrategy(proposedTags, facts.network, facts.hashtagStrategy);
          const placement = effectivePlacement(facts.network, facts.hashtagStrategy);
          const tagText = hashtags.length > 0 ? hashtags.map((t) => `#${t}`).join(" ") : "";
          return {
            draft: {
              body: placement === "body" && tagText ? `${body}\n\n${tagText}`.trim() : body,
              hashtags,
              firstComment: placement === "first_comment" && tagText ? tagText : null,
            },
            draftedVia: "ai",
          };
        }
      } catch {
        /* malformed JSON -> fall through to the deterministic default below */
      }
    }
  }
  return { draft: fallbackCaptionDraft(facts), draftedVia: "fallback" };
}

// ───────────────────────────────────────────── Idea drafting ──────────────────────────────────────
export interface IdeaGroundingFacts {
  engagementName: string;
  campaignGoal: string | null;
  /** The client's own recent posts — design §07: "Clusters the client's own top-performing posts +
   *  campaign goal". A simplification vs. the design's full embed-clustering job (no /embed call,
   *  no k-means): this is a Hermes prompt over the same grounding data, not a clustering pipeline.
   *  Recorded here rather than silently narrowed — a later ticket may add real clustering without
   *  this file's contract changing. */
  recentPosts: Array<{ title: string; brief: string | null }>;
  knowledgeHits: Array<{ sourceRef: string; text: string }>;
  /** How many ideas the CALLER wants — the returned array is capped here, never at the AI's count. */
  count: number;
}
export interface PostIdea {
  title: string;
  brief: string;
}
export interface IdeaDraftResult {
  ideas: PostIdea[];
  draftedVia: "ai" | "fallback";
}

export function buildIdeaPrompt(facts: IdeaGroundingFacts): string {
  const lines = [
    `You are generating social-media content ideas for "${facts.engagementName}".`,
    facts.campaignGoal ? `Campaign goal: ${facts.campaignGoal}` : "No specific campaign goal given — draw on the brand's recent posts.",
  ];
  if (facts.recentPosts.length > 0) {
    lines.push(
      `Recent posts from this brand:\n${facts.recentPosts
        .map((p) => `- ${p.title}${p.brief ? `: ${p.brief}` : ""}`)
        .join("\n")}`,
    );
  }
  if (facts.knowledgeHits.length > 0) {
    lines.push(
      `Excerpts from this brand's approved corpus:\n${facts.knowledgeHits.map((h) => `- (${h.sourceRef}) ${h.text}`).join("\n")}`,
    );
  }
  lines.push(
    `Generate exactly ${facts.count} distinct content ideas. Never suggest generating or attaching`,
    "an image — this system has no image-generation capability.",
    "Reply with STRICT JSON only, no prose, no markdown fences: " +
      `{"ideas": [{"title": "<short working title>", "brief": "<1-2 sentence angle>"}, ...]}`,
  );
  return lines.join("\n");
}

function fallbackIdeas(facts: IdeaGroundingFacts): PostIdea[] {
  const base = facts.campaignGoal?.trim() || facts.engagementName || "this engagement";
  return Array.from({ length: facts.count }, (_, i) => ({
    title: `${base} — idea ${i + 1}`,
    brief: `Draft angle ${i + 1} for ${base} (AI drafting unavailable — deterministic placeholder only).`,
  }));
}

/** Parse the gateway's /complete response for idea drafts. NEVER throws. Caps at `facts.count`
 *  (never the AI's own idea of how many to return) and drops any idea with an empty title. */
export function parseIdeaDraft(raw: string | null, facts: IdeaGroundingFacts): IdeaDraftResult {
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { ideas?: unknown };
        const rawIdeas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
        const ideas: PostIdea[] = rawIdeas
          .filter((i): i is { title?: unknown; brief?: unknown } => !!i && typeof i === "object")
          .map((i) => ({
            title: typeof i.title === "string" ? i.title.trim() : "",
            brief: typeof i.brief === "string" ? i.brief.trim() : "",
          }))
          .filter((i) => i.title.length > 0)
          .slice(0, Math.max(0, Math.min(facts.count, MAX_IDEA_COUNT)));
        if (ideas.length > 0) return { ideas, draftedVia: "ai" };
      } catch {
        /* malformed JSON -> fall through to the deterministic default below */
      }
    }
  }
  return { ideas: fallbackIdeas(facts), draftedVia: "fallback" };
}

// ───────────────────────────────────────────── Report narrative (SMM-23) ──────────────────────────
// The narrative half of "snapshot + AI narrative -> approve -> render -> deliver". This is a
// CLIENT-FACING document on letterhead, so the "no invented numbers" rule that governs the
// snapshot's own KPIs/series/tables (social-reports.controller.ts / reports.ts) matters even more
// here: the prompt below hands the model the EXACT, ALREADY-COMPUTED numbers it may reference and
// tells it plainly that anything not fetched must be named as such, never guessed. `kpis` here is
// the caller's ALREADY-FILTERED list — a metric the module never pulled was omitted before this
// function ever sees it (reports.ts#buildSocialReportSnapshot's own discipline), so this file has
// nothing to filter a second time; its job is only to phrase what it was given honestly.
//
// One necessary honesty limit, named rather than silently assumed away: unlike
// `applyHashtagStrategy` (a bounded, mechanically-enforceable property — a hashtag count), there is
// no equivalent runtime guard here that can strip a hallucinated number out of free-form narrative
// prose. The prompt instructs the model never to state a number it was not given, and the
// deterministic fallback (used whenever the gateway fails or returns something unparsable) states
// ONLY the given numbers verbatim, but an AI response that ignores the instruction and states an
// invented number could still pass `parseReportNarrativeDraft`'s parse check, which validates JSON
// shape, not numeric provenance. Flagged in this ticket's own report-back as a known limitation,
// not silently solved.
export interface ReportNarrativeKpiFact {
  label: string;
  value: number;
  unit: string;
}
export interface ReportNarrativeGroundingFacts {
  engagementName: string;
  clientName: string;
  periodLabel: string;
  /** Already filtered to metrics that were actually fetched — see file header. */
  kpis: ReportNarrativeKpiFact[];
  topPosts: Array<{ network: string; publishedAt: string | null; impressions: number | null }>;
  knowledgeHits: Array<{ sourceRef: string; text: string }>;
}
export interface ReportNarrativeDraftResult {
  text: string;
  draftedVia: "ai" | "fallback";
}

export function buildReportNarrativePrompt(facts: ReportNarrativeGroundingFacts): string {
  const lines = [
    `You are writing the narrative summary section of a social-media performance report for `
      + `"${facts.clientName}" (engagement "${facts.engagementName}"), covering ${facts.periodLabel}.`,
  ];
  if (facts.kpis.length > 0) {
    lines.push(
      "Here are the ONLY numbers you may reference, exactly as given. Do not invent, estimate, "
        + "round differently, or restate any number not in this list:\n"
        + facts.kpis.map((k) => `- ${k.label}: ${k.value} ${k.unit}`).join("\n"),
    );
  } else {
    lines.push(
      "No metrics have been fetched for this engagement yet for this period. Say so plainly — do "
        + "not invent or guess any number, including zero.",
    );
  }
  if (facts.topPosts.length > 0) {
    lines.push(
      "Top posts by impressions this period:\n"
        + facts.topPosts
          .map((p) => `- ${p.network}${p.publishedAt ? ` (${p.publishedAt})` : ""}: ${p.impressions ?? "impressions not yet fetched"}`)
          .join("\n"),
    );
  }
  if (facts.knowledgeHits.length > 0) {
    lines.push(
      `Excerpts from this brand's own approved past posts and guidelines:\n${facts.knowledgeHits
        .map((h) => `- (${h.sourceRef}) ${h.text}`)
        .join("\n")}`,
    );
  }
  lines.push(
    "Write 2-4 short paragraphs in this brand's voice, summarizing performance for the period. "
      + "NEVER state a number you were not given above, and never imply a metric was zero just "
      + "because it was not mentioned — say it has not been fetched yet instead. Never suggest "
      + "generating or attaching an image — this system has no image-generation capability.",
    'Reply with STRICT JSON only, no prose, no markdown fences: {"narrative": "<the summary text>"}',
  );
  return lines.join("\n\n");
}

function fallbackReportNarrative(facts: ReportNarrativeGroundingFacts): string {
  if (facts.kpis.length === 0) {
    return `No metrics have been fetched yet for ${facts.engagementName} during ${facts.periodLabel} `
      + `(AI drafting unavailable — deterministic placeholder only).`;
  }
  const lines = [`Performance summary for ${facts.clientName} — ${facts.periodLabel}.`];
  for (const k of facts.kpis) lines.push(`${k.label}: ${k.value} ${k.unit}.`);
  return lines.join(" ");
}

/** Parse the gateway's /complete response for a report narrative. NEVER throws — see file header
 *  for why this can only validate JSON shape, not numeric provenance. */
export function parseReportNarrativeDraft(raw: string | null, facts: ReportNarrativeGroundingFacts): ReportNarrativeDraftResult {
  if (raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { narrative?: unknown };
        const text = typeof parsed.narrative === "string" ? parsed.narrative.trim() : "";
        if (text.length > 0) return { text, draftedVia: "ai" };
      } catch {
        /* malformed JSON -> fall through to the deterministic default below */
      }
    }
  }
  return { text: fallbackReportNarrative(facts), draftedVia: "fallback" };
}

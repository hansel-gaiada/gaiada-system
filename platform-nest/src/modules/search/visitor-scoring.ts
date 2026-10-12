// M5-V3-e — interests and score for a consented visitor profile (design 2026-10-12 §4.6). PURE: no I/O, no clock
// (the caller passes `now`), no randomness, so the same events and rules always give the same answer.
//
// INTERESTS. Rules (search_interest_rules: data, edited in the tab and by tool) map a path prefix or a `section_id`
// prefix to {facet: industry | service, tag, weight}. Over the last 90 days, a tag scores the sum of rule weights
// over DISTINCT (rule, page) and (rule, section) matches, so visiting one page ten times counts once. The top three
// tags per facet are kept (score desc, then tag asc, so ties are stable). No rules means no interests, never a
// guess: the result is `{}`. The source is the consented event stream only, never a lead's attribution.
//
// SCORE (0..100). Four parts, every one stored in `score_parts` and shown; the score IS their sum:
//   recency    max 25   last visit <= 7 days 25, <= 30 days 15, <= 90 days 5, else 0
//   frequency  max 15   visits 2 -> 5, 3..4 -> 10, >= 5 -> 15, else 0
//   depth      max 30   sum of interest-rule weights over distinct matches (90 days), capped at 30
//   intent     max 30   `lead_form_start` 15; any of cta_click / click_whatsapp / click_phone / click_email 10;
//                       `generate_lead` 5 (each counted once, 90 days); capped at 30
// A score ORDERS A LIST. No job, tool or rule acts on it (R-V1: no decision about a person).
//
// VISITS. The collector has no session id, so a visit is a run of events with no gap longer than 30 minutes (the
// usual web-analytics session rule). Visits and pageviews are recomputed from the profile's stored events every
// time, so a re-pulled batch cannot double-count.

export type InterestFacet = "industry" | "service";
export type InterestMatch = "path_prefix" | "section_prefix";

export interface InterestRule {
  match: InterestMatch;
  pattern: string;
  facet: InterestFacet;
  tag: string;
  weight: number;
}

export interface ScoredEvent {
  occurredAt: Date;
  kind: "pageview" | "event";
  path: string | null;
  name: string | null;
  data: Record<string, unknown> | null;
}

export interface InterestEntry { tag: string; score: number }
export type Interests = Partial<Record<InterestFacet, InterestEntry[]>>;

export interface ScoreParts { recency: number; frequency: number; depth: number; intent: number }

export interface VisitorSummary {
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  visits: number;
  pageviews: number;
  interests: Interests;
  score: number;
  scoreParts: ScoreParts;
}

export const INTEREST_WINDOW_DAYS = 90;
export const TOP_TAGS_PER_FACET = 3;
export const VISIT_GAP_MS = 30 * 60 * 1000;
export const SCORE_MAX: Readonly<ScoreParts> = Object.freeze({ recency: 25, frequency: 15, depth: 30, intent: 30 });

const DAY_MS = 24 * 3600 * 1000;
const FACETS: readonly InterestFacet[] = ["industry", "service"];
const CONTACT_CLICKS = new Set(["cta_click", "click_whatsapp", "click_phone", "click_email"]);

function inWindow(e: ScoredEvent, now: Date): boolean {
  const t = e.occurredAt.getTime();
  return Number.isFinite(t) && now.getTime() - t <= INTEREST_WINDOW_DAYS * DAY_MS;
}

function sectionOf(e: ScoredEvent): string | null {
  const s = e.data?.section_id;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/** Every distinct (rule, target) match in the window. A target is a page path or a section id. */
export function distinctMatches(events: readonly ScoredEvent[], rules: readonly InterestRule[], now: Date): Array<{ rule: InterestRule; target: string }> {
  if (rules.length === 0) return [];
  const paths = new Set<string>();
  const sections = new Set<string>();
  for (const e of events) {
    if (!inWindow(e, now)) continue;
    if (e.path) paths.add(e.path);
    const s = sectionOf(e);
    if (s) sections.add(s);
  }
  const out: Array<{ rule: InterestRule; target: string }> = [];
  for (const rule of rules) {
    if (!rule.pattern || !(rule.weight > 0)) continue;
    const pool = rule.match === "path_prefix" ? paths : sections;
    for (const target of pool) if (target.startsWith(rule.pattern)) out.push({ rule, target });
  }
  return out;
}

/** Top three tags per facet. No rules (or no matches) => `{}`. */
export function computeInterests(events: readonly ScoredEvent[], rules: readonly InterestRule[], now: Date): Interests {
  const byFacet = new Map<InterestFacet, Map<string, number>>();
  for (const { rule } of distinctMatches(events, rules, now)) {
    const tags = byFacet.get(rule.facet) ?? new Map<string, number>();
    tags.set(rule.tag, (tags.get(rule.tag) ?? 0) + rule.weight);
    byFacet.set(rule.facet, tags);
  }
  const out: Interests = {};
  for (const facet of FACETS) {
    const tags = byFacet.get(facet);
    if (!tags || tags.size === 0) continue;
    out[facet] = [...tags.entries()]
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
      .slice(0, TOP_TAGS_PER_FACET);
  }
  return out;
}

export function recencyPoints(lastSeenAt: Date | null, now: Date): number {
  if (!lastSeenAt || !Number.isFinite(lastSeenAt.getTime())) return 0;
  const days = Math.max(0, now.getTime() - lastSeenAt.getTime()) / DAY_MS;
  if (days <= 7) return 25;
  if (days <= 30) return 15;
  if (days <= 90) return 5;
  return 0;
}

export function frequencyPoints(visits: number): number {
  if (visits >= 5) return 15;
  if (visits >= 3) return 10;
  if (visits === 2) return 5;
  return 0;
}

export function depthPoints(events: readonly ScoredEvent[], rules: readonly InterestRule[], now: Date): number {
  let sum = 0;
  for (const { rule } of distinctMatches(events, rules, now)) sum += rule.weight;
  return Math.min(SCORE_MAX.depth, sum);
}

export function intentPoints(events: readonly ScoredEvent[], now: Date): number {
  let formStart = false;
  let contact = false;
  let lead = false;
  for (const e of events) {
    if (e.kind !== "event" || !e.name || !inWindow(e, now)) continue;
    if (e.name === "lead_form_start") formStart = true;
    else if (CONTACT_CLICKS.has(e.name)) contact = true;
    else if (e.name === "generate_lead") lead = true;
  }
  return Math.min(SCORE_MAX.intent, (formStart ? 15 : 0) + (contact ? 10 : 0) + (lead ? 5 : 0));
}

/** A visit = a run of events with no gap over 30 minutes. */
export function countVisits(times: readonly Date[]): number {
  const ts = times.map((d) => d.getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length === 0) return 0;
  let visits = 1;
  for (let i = 1; i < ts.length; i++) if (ts[i]! - ts[i - 1]! > VISIT_GAP_MS) visits++;
  return visits;
}

/** The score and its parts. The score is exactly the sum of the parts (each already within its maximum). */
export function computeScore(a: { lastSeenAt: Date | null; visits: number; events: readonly ScoredEvent[]; rules: readonly InterestRule[]; now: Date }): { score: number; parts: ScoreParts } {
  const parts: ScoreParts = {
    recency: recencyPoints(a.lastSeenAt, a.now),
    frequency: frequencyPoints(a.visits),
    depth: depthPoints(a.events, a.rules, a.now),
    intent: intentPoints(a.events, a.now),
  };
  return { score: parts.recency + parts.frequency + parts.depth + parts.intent, parts };
}

/** Everything a profile row stores that is derived from its events. */
export function summarizeVisitor(events: readonly ScoredEvent[], rules: readonly InterestRule[], now: Date): VisitorSummary {
  const times = events.map((e) => e.occurredAt).filter((d) => Number.isFinite(d.getTime()));
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  const firstSeenAt = sorted[0] ?? null;
  const lastSeenAt = sorted[sorted.length - 1] ?? null;
  const visits = countVisits(times);
  const pageviews = events.filter((e) => e.kind === "pageview").length;
  const { score, parts } = computeScore({ lastSeenAt, visits, events, rules, now });
  return { firstSeenAt, lastSeenAt, visits, pageviews, interests: computeInterests(events, rules, now), score, scoreParts: parts };
}

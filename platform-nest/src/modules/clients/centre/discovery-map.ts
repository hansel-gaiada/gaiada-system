// PV6-04 (CC-D6) — which discovery (AD-3) answers fill which Business-profile (registry) field.
//
// The two vocabularies share only four literal ids (`tagline`, `priority_pages`, `languages`, and the
// false friend `platform`), so the mapping is an explicit table, one row per TARGET profile key, each
// with the source answer ids, how several sources join, and a one-line reason. Pure and DB-free: the
// same `planDiscoveryFill` computes the preview, the staff fill and the conversion-time fill.
//
// NOT mapped on purpose (project-brief data that stays with the lead / the requirement document):
// the visual sliders (`vis_*`, `voice_*`), motion, references, the sitemap block (pages, features,
// navigation), scope and governance (`in_scope`, `decision_makers`, revisions, support), budget and
// dates, the audience problem/objection answers, and `anything_else` / `confidence`.
// Also unmapped for a TYPE mismatch: `has_brand_guidelines` and `logo_files` are choice answers
// ("Yes — vector…"), while the profile's `guidelines` and `logo` are URLs; a sentence there would be a
// broken link. The link answer `asset_link` feeds `assets`.
import registry from "./registry.json";
import { applyCentrePatch, looksLikeCredential, type ProfileState } from "./validation";

type JoinMode = "first" | "lines" | "labelled";

export interface DiscoveryMapEntry {
  /** Registry profile key written. */
  to: string;
  /** AD-3 answer ids read, in order. */
  from: string[];
  /** first: the first non-empty source. lines: non-empty sources joined (newline for a textarea target,
   *  "; " otherwise). labelled: like lines, each prefixed with `labels[i]`. */
  join: JoinMode;
  labels?: string[];
  /** One line: why this pairing is right (or what the catch is). */
  reason: string;
}

const first = (to: string, from: string[], reason: string): DiscoveryMapEntry => ({ to, from, join: "first", reason });
const lines = (to: string, from: string[], reason: string): DiscoveryMapEntry => ({ to, from, join: "lines", reason });
const labelled = (to: string, from: string[], labels: string[], reason: string): DiscoveryMapEntry => ({ to, from, join: "labelled", labels, reason });

export const DISCOVERY_MAP: DiscoveryMapEntry[] = [
  first("legal", ["org_name"], "Business / organisation name is the legal or public entity name"),
  first("trading", ["project_name", "org_name"], "The brand name the client wants used; falls back to the organisation name"),
  first("tagline", ["tagline"], "Same concept and same id: existing tagline or key message"),
  first("description", ["simplest_explanation"], "The simplest explanation of what the business does is the company description"),
  first("website", ["current_url"], "Current website URL (an answer of \"none\" is skipped)"),
  first("email", ["contact_email"], "The primary contact's email is the profile's primary email"),
  first("phone", ["contact_phone"], "The primary contact's phone / WhatsApp number"),
  first("products", ["offering"], "What you sell or provide is Products & services"),
  first("usps", ["differentiator"], "What makes you different is Unique selling points"),
  first("markets", ["market"], "Geographic market is Primary markets"),
  first("service_area", ["market"], "Geographic market also states where the business serves"),
  first("sales_model", ["business_model"], "Business model (B2B, B2C, ...) is the sales model; multi-choice joins with commas"),
  lines("competitors", ["competitor_1_name", "competitor_2_name", "competitor_3_name", "competitors_other"],
    "Named competitors; the per-competitor assessments are project-brief detail and are not copied"),
  first("audience", ["primary_audience"], "The most important visitor is the target audience"),
  first("segments", ["secondary_audiences"], "Secondary audiences are customer segments"),
  labelled("voice", ["tone", "brand_adjectives"], ["Tone: ", "Brand: "], "Copy tone and brand adjectives together describe the tone of voice"),
  labelled("messaging", ["brand_promise", "homepage_core_message", "supporting_messages"],
    ["Promise: ", "Core message: ", "Supporting: "], "Brand promise and the homepage messages are the key messages"),
  labelled("positioning", ["category_in", "why_choose_you"], ["Category: ", "Why us: "], "The category customers should place you in, plus why choose you, is the positioning statement"),
  first("awards", ["proof"], "The proof behind the claim (awards, certifications, results) is Certifications, awards & memberships"),
  first("assets", ["asset_link"], "Link to the brand assets is the Brand asset library link"),
  first("color", ["brand_colours"], "Brand colours answer the Primary brand colour (free text, HEX or Pantone)"),
  first("keywords", ["seo_requirements"], "SEO requirements are Target keywords & topics"),
  first("priority_pages", ["priority_pages"], "Same concept and same id: which pages matter most"),
  first("languages", ["languages"], "Same id; the multi-choice array joins with commas into the profile's text field"),
  first("conversions", ["conversion_type"], "What counts as a conversion; same concept"),
  labelled("goals", ["objective", "priorities"], ["Objective: ", "Priorities: "], "What the website must accomplish plus the top business priorities are the goals"),
  labelled("kpis", ["success_metrics", "primary_metric"], ["Metrics: ", "Primary: "], "The success metrics and the one primary metric are the KPIs tracked"),
  labelled("stack", ["integrations", "integration_providers"], ["Systems: ", "Providers: "], "The systems the site integrates with, and their providers, describe the tech stack"),
  labelled("domains", ["dns_owner"], ["Domain and DNS controlled by: "], "Closest domain answer: who controls the domain and DNS (labelled so it is not read as a domain list)"),
  first("cms", ["platform"], "FALSE FRIEND: AD-3 platform is the preferred website platform, so it is the CMS, not the e-commerce platform"),
  first("content", ["existing_content"], "Existing content to look at is Existing content assets"),
];

/** Answers that carry no information and are never written. */
const EMPTY_ANSWER = /^(none|n\/a|na|tbd|to be defined|-)\.?$/i;
/** Platform answers that name no platform. */
const NON_PLATFORM = /^(no preference|keep our current platform)/i;

const FIELD_TYPES = registry.fields as Record<string, { type: string }>;

/** An answer as one trimmed string: text as is, a choice list joined with ", ". Anything else
 *  (a grid, an object, a number) is not a single value and is not mapped. */
export function answerText(value: unknown): string | null {
  let s: string | null = null;
  if (typeof value === "string") s = value;
  else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    s = (value as string[]).map((v) => v.trim()).filter(Boolean).join(", ");
  }
  if (s === null) return null;
  s = s.trim();
  return s === "" || EMPTY_ANSWER.test(s) ? null : s;
}

/** The value one table row would write for these answers, or null when none of its sources answered. */
export function valueFor(entry: DiscoveryMapEntry, answers: Record<string, unknown>): string | null {
  const parts = entry.from.map((id) => {
    const t = answerText(answers[id]);
    if (t === null) return null;
    if (entry.to === "cms" && NON_PLATFORM.test(t)) return null;
    return t;
  });
  if (entry.join === "first") return parts.find((p) => p !== null) ?? null;
  const present = parts
    .map((p, i) => (p === null ? null : entry.join === "labelled" ? `${entry.labels?.[i] ?? ""}${p}` : p))
    .filter((p): p is string => p !== null);
  if (present.length === 0) return null;
  return present.join(FIELD_TYPES[entry.to]?.type === "textarea" ? "\n" : "; ");
}

export interface DiscoveryFillPlan {
  /** key → value that will be written (empty target, value passed the PATCH validation). */
  fill: Record<string, string>;
  /** keys with an answer that were NOT written, and why. */
  skipped: { key: string; reason: string }[];
}

/** One planner for the preview, the staff fill and the conversion fill. Never overwrites a filled key
 *  and validates every value through the PATCH validator (the credential scanner included); a refused
 *  value is skipped and named, it never aborts the others. */
export function planDiscoveryFill(answers: Record<string, unknown>, state: ProfileState): DiscoveryFillPlan {
  const fill: Record<string, string> = {};
  const skipped: { key: string; reason: string }[] = [];
  for (const entry of DISCOVERY_MAP) {
    const value = valueFor(entry, answers);
    if (value === null) continue;
    if ((state.profile[entry.to] ?? "").trim() !== "") {
      skipped.push({ key: entry.to, reason: "already filled" });
      continue;
    }
    const checked = applyCentrePatch(state, { profile: { [entry.to]: value } });
    if ("error" in checked) {
      skipped.push({ key: entry.to, reason: looksLikeCredential(value) ? "looks like a credential" : checked.error });
      continue;
    }
    fill[entry.to] = value;
  }
  return { fill, skipped };
}

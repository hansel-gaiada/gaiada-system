// SM-33 — the SIMULATION provider tier (docs/blueprints/seo-sem-execution-tracker.md §6 SM-33).
//
// WHY THIS EXISTS: the owner directive is "no live vendor API until staging", so dev has to show
// believable results and data. The pre-existing `mock-provider.ts` is a TEST stub — flat constants
// (every keyword volume 1200, every domain 5321 backlinks) and never registered at bootstrap — so a
// keyless dev deployment renders every paid capability as "not yet pulled" and the department cannot
// be demoed. mock-provider.ts stays exactly as it is (the money-safety suites depend on its call
// counter and its constant costs); this file is the DEMO/dev tier that sits beside it.
//
// THREE PROPERTIES, EACH DELIBERATE
//
//  1. DETERMINISTIC, SEEDED FROM THE QUERY. Not random: a demo and a test must reproduce, and a
//     re-pull of the same keyword must not "move the rankings". Not constant either: flat data hides
//     every rendering bug (a chart of 40 identical bars looks fine no matter how broken the
//     axis/sort/format code is). Every number here is a pure function of
//     (vendor, normalized query, locale, location) via a hash — no Math.random, no Date.now.
//
//  2. PER-VENDOR CAPABILITY HONESTY. Each driver advertises only what its real vendor sells
//     (Semrush: volume/difficulty/backlinks/competitors/serp · Ahrefs: backlinks/volume/difficulty/
//     competitors/serp · DataForSEO: all of it, plus suggestions + ai_visibility). A simulator that
//     could do everything would mask exactly the class of bug SM-36's per-capability preference
//     cascade is about to introduce. The methods a vendor does NOT advertise THROW rather than
//     returning plausible data, so a capability-routing bug is loud instead of invisible.
//
//  3. THE VENDORS DISAGREE, SLIGHTLY. Real Semrush, Ahrefs and DataForSEO return different volumes
//     for the same keyword and materially different backlink counts for the same domain. So each
//     driver applies a bounded, deterministic per-vendor bias/jitter over a SHARED market truth:
//     same order of magnitude, never the same number. Code that assumes two vendors agree is broken,
//     and this is what makes that visible in dev instead of in staging.
//
// PROVENANCE: these drivers carry `simulated = true`. dispatch.ts stamps that onto every ledger row
// and cache write (migration 0047); the cache read and both budget counters carry a
// `simulated = <mode>` predicate, so synthetic data can never be read back as real and synthetic
// dollars can never bind a real client's budget (addendum §A4.1/§A4.2). See providers/cache.ts,
// providers/ledger.ts and migrations/0047_search_provider_simulation.sql.
//
// MODE/DRIVER MUTUAL EXCLUSION (addendum §A4.3) is enforced at REGISTRATION in main.ts (SM-34's
// wiring): simulation drivers register only in `simulate` mode, real drivers only in `live` mode, and
// a simulation driver in live mode is a boot error. That is the structural guarantee that no
// simulated row can be created in live mode; the per-dispatch mode check in dispatch.ts is a cheap
// second belt, not the mechanism.
//
// PRICING comes from the REAL rate tables, not a parallel invented one (§A4.5) — see the pricing
// block below.
import { config } from "../../../config";
import { AHREFS_RATES, computeAhrefsCostPerUnitUsd } from "./ahrefs";
import { DFS_RATES } from "./dataforseo";
import { SEMRUSH_RATES, computeSemrushCostPerUnitUsd } from "./semrush";
import {
  type AiVisibilityQuery,
  type AiVisibilityResult,
  type BacklinkSummary,
  type Capability,
  type KeywordMetrics,
  type KeywordQuery,
  type ProviderKey,
  type ProviderOp,
  type SearchDataProvider,
  type SerpRequest,
  type SerpResult,
  type TaskRef,
} from "./types";

// ── mode ────────────────────────────────────────────────────────────────────────────────────────────
export type ProviderMode = "live" | "simulate";

/** The platform provider mode (`config.search.providerMode`, SM-34's wiring: `live` by default so
 *  nothing changes by accident). Read at CALL time, never captured at module load, so an operator —
 *  or a test — flipping the mode takes effect on the next dispatch rather than on the next process
 *  restart, and so dispatch/ledger/cache all read one value from one place. */
export function providerMode(): ProviderMode {
  return config.search.providerMode;
}

export function isSimulationMode(): boolean {
  return providerMode() === "simulate";
}

/** Is THIS driver a simulator? Structural (not `instanceof`) on purpose: provenance must follow the
 *  object that actually produced the bytes, even for a driver written elsewhere later, and this file
 *  cannot add a field to the SM-34-owned `SearchDataProvider` interface. Any driver that synthesizes
 *  data marks itself with `simulated = true`; anything unmarked is treated as REAL, which is the
 *  fail-safe default for a *cost* record (over-claiming "real" on synthetic data is the expensive
 *  lie — so the flag is also OR'd with the platform mode in dispatch.ts). */
export function isSimulatedProvider(p: Pick<SearchDataProvider, "key"> | null | undefined): boolean {
  return (p as { simulated?: unknown } | null | undefined)?.simulated === true;
}

// ── deterministic primitives ────────────────────────────────────────────────────────────────────────
/** FNV-1a. Stable across processes and Node versions (plain integer math, no locale, no crypto) —
 *  which is what "same input -> same output, forever" requires. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic value in [0,1) from any list of seed parts (mulberry32 finalizer over FNV-1a, so
 *  neighbouring seeds like "kw|1" / "kw|2" decorrelate instead of producing adjacent outputs). */
function unit(...parts: Array<string | number>): number {
  let t = (hash32(parts.join("")) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic multiplicative jitter in [1-spread, 1+spread]. */
function jitter(spread: number, ...parts: Array<string | number>): number {
  return 1 + (unit(...parts) * 2 - 1) * spread;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function normalize(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function slugify(q: string): string {
  return normalize(q).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

function titleCase(q: string): string {
  return normalize(q).split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Vendors report ROUNDED volumes (nobody publishes "1,237 searches/mo"). Rounding on a ladder is
 *  also what makes a simulated series look like a real export at a glance. */
function reportedVolume(v: number): number {
  if (v < 10) return Math.max(0, Math.round(v));
  if (v < 100) return Math.round(v / 10) * 10;
  if (v < 1_000) return Math.round(v / 50) * 50;
  if (v < 10_000) return Math.round(v / 100) * 100;
  if (v < 100_000) return Math.round(v / 500) * 500;
  return Math.round(v / 1_000) * 1_000;
}

// ── intent classification (drives CPC, SERP features, ad presence) ──────────────────────────────────
export type Intent = "transactional" | "commercial" | "informational" | "navigational";

const TRANSACTIONAL_TOKENS = [
  "buy", "price", "prices", "pricing", "cost", "cheap", "cheapest", "discount", "deal", "deals",
  "coupon", "order", "shop", "for sale", "quote", "hire", "book", "subscription", "near me",
  "delivery", "install", "installation", "service", "services", "agency", "consultant",
];
const COMMERCIAL_TOKENS = [
  "best", "top", "review", "reviews", "vs", "versus", "comparison", "compare", "alternative",
  "alternatives", "software", "tool", "tools", "platform", "ranking", "rated",
];
const INFORMATIONAL_TOKENS = [
  "how", "how to", "what", "what is", "why", "when", "who", "guide", "tutorial", "meaning",
  "definition", "example", "examples", "ideas", "tips", "checklist", "template", "learn",
];
const NAVIGATIONAL_TOKENS = [
  "login", "log in", "sign in", "sign up", "official", "website", "app", "download",
  "customer service", "phone number", "contact",
];

function containsAny(keyword: string, tokens: string[]): boolean {
  const padded = ` ${keyword} `;
  return tokens.some((t) => (t.includes(" ") ? padded.includes(` ${t} `) || keyword.includes(t) : padded.includes(` ${t} `)));
}

/** Intent from the query's own tokens — deliberately rule-based, not hashed: a demo where
 *  "buy running shoes" is classified informational (and priced at $0.30 CPC) teaches the viewer the
 *  wrong thing about the product. Precedence: navigational > transactional > commercial >
 *  informational, because the more specific signal wins ("best crm login" is a login query). */
export function classifyIntent(keyword: string): Intent {
  const k = normalize(keyword);
  if (containsAny(k, NAVIGATIONAL_TOKENS)) return "navigational";
  if (containsAny(k, TRANSACTIONAL_TOKENS)) return "transactional";
  if (containsAny(k, COMMERCIAL_TOKENS)) return "commercial";
  if (containsAny(k, INFORMATIONAL_TOKENS)) return "informational";
  // No signal at all: the head-term case ("running shoes"). Short queries lean commercial, long
  // ones lean informational — the same shape the length/volume relationship below assumes.
  return k.split(" ").length <= 2 ? "commercial" : "informational";
}

// ── the shared "market truth" every vendor then disagrees slightly about ────────────────────────────
export interface SimulatedMarket {
  keyword: string;
  wordCount: number;
  intent: Intent;
  /** Monthly search volume on a long-tail (Pareto) distribution, length-corrected. */
  volume: number;
  cpcUsd: number;
  /** 1-100, a monotone function of volume plus a commercial-intent premium. */
  difficulty: number;
}

// Long-tail shape: v = VOL_MIN * u^(-1/alpha). alpha 1.25 gives a genuinely heavy tail — the median
// keyword sits at ~1.74x VOL_MIN, ~1 in 100 at ~40x, ~1 in 1000 at ~250x — which is the actual shape
// of a keyword export and the reason a volume histogram is worth rendering at all. Calibrated (with
// WORD_FACTOR below) so a 3-word phrase lands around 750/mo, a single head term around 15k/mo, and
// the top of a few-hundred-keyword set reaches the hundreds of thousands: the ranges an SEO looks at
// and immediately either believes or doesn't.
const VOL_MIN = 430;
const VOL_ALPHA = 1.25;
// Word count -> volume multiplier. THE long-tail correlation: head terms are short and huge, and
// each extra qualifier word cuts the audience hard.
const WORD_FACTOR = [20, 20, 5, 1, 0.4, 0.18, 0.09];
// Intent -> CPC multiplier over the base. Transactional queries are what advertisers actually bid on.
const INTENT_CPC: Record<Intent, number> = {
  transactional: 3.2,
  commercial: 1.9,
  informational: 1.0,
  navigational: 0.55,
};
const INTENT_DIFFICULTY_BONUS: Record<Intent, number> = {
  transactional: 7,
  commercial: 4,
  informational: 0,
  navigational: -3,
};

/** The vendor-independent truth for one keyword in one market. Every driver derives from this, so
 *  the vendors agree on the order of magnitude and disagree on the last digits — exactly like life. */
export function simulateMarket(keyword: string, locale?: string, locationCode?: number): SimulatedMarket {
  const k = normalize(keyword);
  const market = `${locale ?? "_"}|${locationCode ?? "_"}`;
  const wordCount = k.split(" ").filter(Boolean).length || 1;
  const intent = classifyIntent(k);

  const u = clamp(unit("volume", k, market), 1e-6, 0.999999);
  const pareto = VOL_MIN * Math.pow(u, -1 / VOL_ALPHA);
  const lengthFactor = WORD_FACTOR[Math.min(wordCount, WORD_FACTOR.length - 1)];
  const volume = reportedVolume(clamp(pareto * lengthFactor, 0, 2_400_000));

  // Difficulty rides volume (log10 — an order of magnitude more searchers is roughly a fixed step
  // harder to outrank), plus the commercial-intent premium, plus a small keyword-specific wobble.
  const difficulty = clamp(
    (4 + 12.5 * Math.log10(volume + 10) + INTENT_DIFFICULTY_BONUS[intent]) * jitter(0.07, "kd", k, market),
    1,
    100,
  );

  // CPC follows intent first, then difficulty (a contested SERP is a contested auction).
  const cpcUsd = Math.max(
    0.02,
    0.35 * INTENT_CPC[intent] * (0.6 + 1.9 * unit("cpc", k, market)) * (1 + 0.9 * (difficulty / 100)),
  );

  return { keyword: k, wordCount, intent, volume, cpcUsd, difficulty };
}

/** Deterministic keyword suggestions (only the DataForSEO sim advertises `suggestions`). */
function simulateSuggestions(keyword: string, count: number): string[] {
  const k = normalize(keyword);
  const shapes = [
    `${k} price`, `best ${k}`, `${k} reviews`, `${k} near me`, `how to ${k}`,
    `${k} alternatives`, `cheap ${k}`, `${k} vs`, `${k} for beginners`, `${k} 2026`,
    `${k} checklist`, `${k} services`,
  ];
  return shapes
    .map((s, i) => ({ s, rank: unit("sugg", k, i) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, count)
    .map((x) => x.s);
}

// ── SERP synthesis ──────────────────────────────────────────────────────────────────────────────────
const EVERGREEN_DOMAINS = [
  "en.wikipedia.org", "www.reddit.com", "www.youtube.com", "medium.com", "www.quora.com",
  "www.forbes.com", "www.linkedin.com", "www.nytimes.com", "www.pinterest.com", "github.com",
];
const COMMERCE_DOMAINS = ["www.amazon.com", "www.etsy.com", "www.walmart.com", "www.ebay.com", "shop.example-retail.com"];
const B2B_DOMAINS = ["www.g2.com", "www.capterra.com", "blog.hubspot.com", "www.zendesk.com", "www.salesforce.com"];

const TITLE_SHAPES = [
  "{K} — The Complete 2026 Guide",
  "Best {K}: Top Picks, Tested & Ranked",
  "{K}: What It Is and How It Works",
  "10 {K} Ideas That Actually Work",
  "{K} Pricing & Plans Compared",
  "{K} — Everything You Need to Know",
];

/** A believable title for one result. Templates that would stutter on a keyword already starting
 *  with "best"/"top" ("Best Best Crm Software") are dropped — the kind of artifact that makes a
 *  viewer stop trusting everything else on the page. */
function serpTitle(keyword: string, domain: string): string {
  const k = normalize(keyword);
  const superlative = /^(best|top|cheapest)\b/.test(k);
  const shapes = superlative ? TITLE_SHAPES.filter((t) => !/^(Best|10) /.test(t)) : TITLE_SHAPES;
  return shapes[Math.floor(unit("title", k, domain) * shapes.length)].replace("{K}", titleCase(k));
}

/** URL shapes real sites actually use. A SERP where every row is `https://host/keyword-slug` reads
 *  as generated at a glance; wikipedia's /wiki/, YouTube's watch ids and Amazon's /dp/ ASINs are the
 *  cheap details that make a screenshot look like a screenshot. */
function serpUrl(keyword: string, domain: string): string {
  const s = slugify(keyword);
  const token = (len: number, salt: string) =>
    hash32(`${salt}|${domain}|${s}`).toString(36).padStart(len, "0").slice(0, len);
  if (domain.endsWith("wikipedia.org")) return `https://${domain}/wiki/${titleCase(keyword).replace(/ /g, "_")}`;
  if (domain.endsWith("youtube.com")) return `https://${domain}/watch?v=${token(11, "yt")}`;
  if (domain.endsWith("reddit.com")) return `https://${domain}/r/${s.split("-")[0]}/comments/${token(7, "rd")}/${s.replace(/-/g, "_")}/`;
  if (domain.endsWith("pinterest.com")) return `https://${domain}/pin/${hash32(`pin|${s}`) % 1_000_000_000}/`;
  if (domain.endsWith("amazon.com")) return `https://${domain}/dp/B0${token(8, "az").toUpperCase()}`;
  if (domain.endsWith("etsy.com") || domain.endsWith("ebay.com") || domain.endsWith("walmart.com")) {
    return `https://${domain}/listing/${hash32(`li|${domain}|${s}`) % 100_000_000}/${s}`;
  }
  if (domain.endsWith("quora.com")) return `https://${domain}/${titleCase(keyword).replace(/ /g, "-")}`;
  return `https://${domain}/${unit("path", keyword, domain) < 0.45 ? "blog/" : ""}${s}`;
}

/** SERP feature probabilities per intent. These are the features the console's GEO/AEO surfaces read,
 *  so they must vary with intent: an AI overview on 100% of transactional queries (or 0% of
 *  informational ones) would make the GEO pillar's charts nonsense. */
const FEATURE_P: Record<string, Record<Intent, number>> = {
  ai_overview: { informational: 0.62, commercial: 0.4, transactional: 0.18, navigational: 0.08 },
  featured_snippet: { informational: 0.45, commercial: 0.3, transactional: 0.12, navigational: 0.05 },
  people_also_ask: { informational: 0.78, commercial: 0.7, transactional: 0.45, navigational: 0.2 },
  video: { informational: 0.42, commercial: 0.3, transactional: 0.18, navigational: 0.1 },
  image_pack: { informational: 0.3, commercial: 0.32, transactional: 0.35, navigational: 0.15 },
  shopping: { informational: 0.03, commercial: 0.25, transactional: 0.6, navigational: 0.05 },
  top_ads: { informational: 0.12, commercial: 0.45, transactional: 0.7, navigational: 0.15 },
  local_pack: { informational: 0.06, commercial: 0.1, transactional: 0.22, navigational: 0.08 },
  sitelinks: { informational: 0.2, commercial: 0.25, transactional: 0.3, navigational: 0.8 },
};

function serpFeatures(keyword: string, intent: Intent, reported: string[]): Record<string, boolean> {
  const k = normalize(keyword);
  const local = /\bnear me\b|\bin [a-z]+$/.test(k);
  const out: Record<string, boolean> = {};
  for (const name of reported) {
    const p = FEATURE_P[name]?.[intent] ?? 0.15;
    const boosted = name === "local_pack" && local ? 0.88 : p;
    out[name] = unit("feature", name, k) < boosted;
  }
  return out;
}

// ── backlink synthesis ──────────────────────────────────────────────────────────────────────────────
/** Registrable-ish domain from anything the caller passed (URL, host, bare domain). Deliberately
 *  simple: this is a seed normalizer, not a PSL implementation. */
export function registrableDomain(target: string): string {
  let t = normalize(target).replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^www\./, "");
  t = t.split(":")[0];
  return t || "example.com";
}

// A domain's authority is not random — these are the sites every backlink demo has in it, and a
// simulator that gave wikipedia.org 84,000 referring domains would look broken to anyone who has
// ever opened Ahrefs. Expressed as FLOORS (not multipliers over the random base) because that is
// what makes them reliable: a multiplier still leaves a mega-domain looking small whenever its own
// seed happened to draw a low base.
const MEGA_DOMAIN_FLOOR: Record<string, number> = {
  "google.com": 2_600_000, "youtube.com": 1_900_000, "wikipedia.org": 1_700_000,
  "amazon.com": 1_200_000, "linkedin.com": 900_000, "reddit.com": 800_000,
  "nytimes.com": 620_000, "github.com": 520_000, "forbes.com": 430_000,
};
const TLD_FACTOR: Record<string, number> = {
  gov: 3.4, edu: 3.0, org: 1.35, com: 1.0, io: 0.8, co: 0.75, net: 0.9,
  info: 0.4, biz: 0.35, xyz: 0.25, top: 0.2,
};

export interface SimulatedBacklinkProfile {
  domain: string;
  refDomains: number;
  backlinks: number;
  authorityScore: number;
}

/** Backlink profile scaled to the DOMAIN (not the keyword): a heavy-tailed referring-domain count
 *  modulated by TLD and name length (short names are older//bigger), with the well-known giants
 *  pinned high, then a realistic links-per-referring-domain fan-out on top. */
export function simulateBacklinks(target: string): SimulatedBacklinkProfile {
  const domain = registrableDomain(target);
  const parts = domain.split(".");
  const tld = parts[parts.length - 1] ?? "com";
  const apex = parts.length >= 2 ? parts.slice(-2).join(".") : domain;
  const nameLen = (parts[0] ?? domain).length;

  const u = clamp(unit("refdomains", domain), 1e-6, 0.999999);
  let refDomains = 40 * Math.pow(u, -1 / 1.05);
  refDomains *= TLD_FACTOR[tld] ?? 0.6;
  // Short, wordy names correlate with age and brand; a 24-character hyphenated domain does not.
  refDomains *= clamp(2.4 - nameLen * 0.09, 0.35, 2.2);
  const floor = MEGA_DOMAIN_FLOOR[apex];
  if (floor !== undefined) refDomains = Math.max(refDomains, floor * jitter(0.15, "mega", domain));
  refDomains = clamp(Math.round(refDomains), 1, 12_000_000);

  // Links per referring domain: sitewide footers and blogrolls make this fan out hard.
  const perDomain = 3 + 44 * Math.pow(unit("linkfan", domain), 1.6);
  const backlinks = clamp(Math.round(refDomains * perDomain), refDomains, 1_400_000_000);
  const authorityScore = clamp(Math.round(6 + 11.5 * Math.log10(refDomains + 1)), 1, 100);

  return { domain, refDomains, backlinks, authorityScore };
}

// ── AI-visibility synthesis (GEO pillar) ────────────────────────────────────────────────────────────
// The five engines search_ai_visibility.engine's CHECK constraint accepts (0034). Anything else
// would be synthesized data that cannot be persisted — a simulator whose output the schema rejects
// is worse than no simulator.
export const AI_ENGINES = ["chatgpt", "google_ai_overview", "gemini", "claude", "perplexity"] as const;

/** Per-engine citation behaviour. Perplexity cites sources on nearly every answer; Claude mentions
 *  brands but links least; Google's AI Overview sits between. The point of varying this is that the
 *  GEO console's per-engine comparison is only meaningful if the engines differ. */
const ENGINE_BEHAVIOUR: Record<string, { mention: number; citeGivenMention: number; prominence: number }> = {
  chatgpt: { mention: 0.62, citeGivenMention: 0.55, prominence: 0.62 },
  google_ai_overview: { mention: 0.55, citeGivenMention: 0.78, prominence: 0.7 },
  gemini: { mention: 0.5, citeGivenMention: 0.6, prominence: 0.58 },
  claude: { mention: 0.44, citeGivenMention: 0.32, prominence: 0.5 },
  perplexity: { mention: 0.7, citeGivenMention: 0.92, prominence: 0.8 },
};

function simulateAiVisibility(query: string, engine: string): AiVisibilityResult {
  const q = normalize(query);
  const b = ENGINE_BEHAVIOUR[engine] ?? { mention: 0.5, citeGivenMention: 0.5, prominence: 0.55 };
  const brandMentioned = unit("aimention", engine, q) < b.mention;
  const cited = brandMentioned && unit("aicite", engine, q) < b.citeGivenMention;
  const prominence = Number(
    clamp((cited ? b.prominence : b.prominence * 0.45) * jitter(0.25, "aiprom", engine, q), 0, 1).toFixed(2),
  );
  return {
    engine,
    query: q,
    brandMentioned,
    cited,
    ...(cited ? { citedUrl: `https://${slugify(q).slice(0, 24)}-brand.example.com/${slugify(q)}` } : {}),
    prominence,
  };
}

// ── vendor profiles: the deliberate divergence + the (simulation-only) price models ─────────────────
interface VendorProfile {
  key: ProviderKey;
  label: string;
  capabilities: Capability[];
  /** Multiplicative bias + bounded jitter applied to the shared market truth. */
  volumeBias: number;
  volumeJitter: number;
  difficultyBias: number;
  difficultyJitter: number;
  cpcBias: number;
  cpcJitter: number;
  /** Ahrefs' index is its selling point and reports the most links; DFS's PAYG index the fewest. */
  backlinkBias: number;
  /** Integer difficulty (Semrush/Ahrefs KD) vs one decimal (DFS Labs). A rendering bug on a
   *  `.toFixed(0)` assumption shows up as soon as two vendors format differently. */
  difficultyDecimals: number;
  /** Which SERP features this vendor's reports actually carry. */
  reportedSerpFeatures: string[];
  /** How many organic rows the vendor's SERP report returns. */
  serpRows: number;
  /** Weight of the vendor-specific reshuffle of the shared SERP ordering (0 = identical to truth). */
  serpDivergence: number;
}

const VENDOR_PROFILES: VendorProfile[] = [
  {
    key: "dataforseo",
    label: "DataForSEO (simulated)",
    // The broadest surface: SERP, Labs, Keywords Data, Backlinks — and the only one of the three
    // that can serve `suggestions` and `ai_visibility` as first-class ops.
    capabilities: ["serp", "volume", "suggestions", "difficulty", "backlinks", "competitors", "ai_visibility"],
    volumeBias: 1.0, volumeJitter: 0.06,
    difficultyBias: 1.0, difficultyJitter: 0.05,
    cpcBias: 1.0, cpcJitter: 0.08,
    backlinkBias: 0.8,
    difficultyDecimals: 1,
    reportedSerpFeatures: ["ai_overview", "featured_snippet", "people_also_ask", "video", "image_pack", "shopping", "top_ads", "local_pack", "sitelinks"],
    serpRows: 10,
    serpDivergence: 0.1,
  },
  {
    key: "semrush",
    label: "Semrush (simulated)",
    // Analytics API v3: keyword overview, organic positions (our `serp`), backlinks overview,
    // competitors. NO keyword-suggestions op and NO AI-visibility product.
    capabilities: ["volume", "difficulty", "backlinks", "competitors", "serp"],
    volumeBias: 1.08, volumeJitter: 0.1,
    difficultyBias: 1.05, difficultyJitter: 0.08,
    cpcBias: 1.15, cpcJitter: 0.12,
    backlinkBias: 0.95,
    difficultyDecimals: 0,
    reportedSerpFeatures: ["ai_overview", "featured_snippet", "people_also_ask", "shopping", "top_ads", "local_pack", "sitelinks"],
    serpRows: 10,
    serpDivergence: 0.18,
  },
  {
    key: "ahrefs",
    label: "Ahrefs (simulated)",
    capabilities: ["backlinks", "volume", "difficulty", "competitors", "serp"],
    volumeBias: 0.92, volumeJitter: 0.1,
    difficultyBias: 0.97, difficultyJitter: 0.09,
    cpcBias: 0.9, cpcJitter: 0.12,
    backlinkBias: 1.35, // its index is the product
    difficultyDecimals: 0,
    reportedSerpFeatures: ["ai_overview", "featured_snippet", "people_also_ask", "video", "top_ads", "sitelinks"],
    serpRows: 10,
    serpDivergence: 0.22,
  },
];

// ── pricing: the REAL rate tables and the REAL formulas (addendum §A4.5 / §A6-A3) ───────────────────
// The whole value of a simulated demo is that SM-29's price tags and the stop-loss's arithmetic behave
// in dev the way they will behave in staging. A parallel invented price table would defeat that, so
// this file imports the SAME constants the live drivers use and reproduces their per-kind formulas
// exactly — DFS_RATES (dataforseo.ts), SEMRUSH_RATES + computeSemrushCostPerUnitUsd (semrush.ts),
// AHREFS_RATES + computeAhrefsCostPerUnitUsd (ahrefs.ts). Those unit-count tables are public,
// vendor-documented report costs; keeping one copy means a corrected figure lands in the demo and in
// production together, and it is why the sim SERP op for Ahrefs prices at $0 (that report is
// confirmed free) rather than at something invented to look plausible.
//
// The ONE genuinely unknown input is each prepaid vendor's $/unit ratio: it comes from owner-supplied
// plan facts (`monthlyPlanPriceUsd ÷ monthlyUnitAllowance`, §A3.1) that default to 0 because nobody
// has read the vendor consoles yet (§A7 OQ-9/OQ-10). For the LIVE drivers a non-positive rate means
// "do not register" (§A3.3/B1) — a $0 estimate would disarm the stop-loss for that vendor. A
// SIMULATOR cannot take that branch: the entire premise is "no vendor account yet", so refusing to
// register would leave nothing to demo. It takes the other fail-closed option instead — a
// clearly-named PLACEHOLDER ratio, never asserted anywhere as vendor truth, which preserves the
// property that actually matters here: a simulated op is never priced at $0 by accident.
//
// PLACEHOLDER derivations (order-of-magnitude only, superseded the moment config carries real plan
// facts — at which point these lines stop being used at all):
//   Semrush — Business-tier plan ~$499.95/mo against ~10,000 API units/day (~300,000/mo).
//   Ahrefs  — API-unit add-on modelled at ~$500 per 1,000,000 units.
const PLACEHOLDER_SEMRUSH_USD_PER_UNIT = computeSemrushCostPerUnitUsd(499.95, 300_000);
const PLACEHOLDER_AHREFS_USD_PER_UNIT = computeAhrefsCostPerUnitUsd(500, 1_000_000);

/** The configured amortized unit rate for a prepaid vendor, or the placeholder — computed through the
 *  live driver's own derivation function so the ratio can never drift between the two paths. */
function unitRateUsd(vendor: "semrush" | "ahrefs"): number {
  const configured = vendor === "semrush"
    ? computeSemrushCostPerUnitUsd(config.search.semrush.monthlyPlanPriceUsd, config.search.semrush.monthlyUnitAllowance)
    : computeAhrefsCostPerUnitUsd(config.search.ahrefs.monthlyApiTierPriceUsd, config.search.ahrefs.monthlyApiTierUnitAllowance);
  if (configured > 0) return configured;
  return vendor === "semrush" ? PLACEHOLDER_SEMRUSH_USD_PER_UNIT : PLACEHOLDER_AHREFS_USD_PER_UNIT;
}

/** Mirrors each live driver's estimateCostUsd() formula, constant for constant — including its
 *  per-kind SHAPE (Semrush charges difficulty alongside volume; Ahrefs charges its backlinks bases
 *  per item but its keyword base once per call; Ahrefs SERP is free). A simulated projection that
 *  disagreed with the live projection would make the whole demo misleading about cost. */
function estimateFor(key: string, op: ProviderOp): number {
  const items = Math.max(1, op.items ?? 1);
  if (key === "semrush") {
    const rate = unitRateUsd("semrush");
    switch (op.kind) {
      // difficulty rides the volume op, so both report costs are charged together (as in semrush.ts).
      case "volume":
        return (SEMRUSH_RATES.keywordOverviewUnitsPerLine + SEMRUSH_RATES.keywordDifficultyUnitsPerLine) * items * rate;
      case "serp": return SEMRUSH_RATES.serpUnitsPerLine * items * rate;
      case "backlinks": return SEMRUSH_RATES.backlinksUnitsPerLine * items * rate;
      // Not advertised by this vendor. The live driver THROWS here rather than returning a price for
      // a product it cannot sell; the simulator does the same, so a capability-routing bug surfaces
      // identically in dev and in staging instead of quietly producing a number.
      case "suggestions":
      case "ai_visibility":
        throw new Error(`semrush (simulated) does not support op kind '${op.kind}' — it is not an advertised capability`);
    }
  }
  if (key === "ahrefs") {
    const rate = unitRateUsd("ahrefs");
    switch (op.kind) {
      case "backlinks":
        return (AHREFS_RATES.backlinksStatsBaseUnits + AHREFS_RATES.domainRatingBaseUnits) * items * rate;
      case "volume":
        return (AHREFS_RATES.keywordsOverviewBaseUnits +
          AHREFS_RATES.keywordsOverviewPerFieldUnits * AHREFS_RATES.keywordsOverviewAssumedFields * items) * rate;
      case "serp": return AHREFS_RATES.serpOverviewUnits * items * rate; // confirmed free upstream
      case "suggestions":
      case "ai_visibility":
        throw new Error(`ahrefs (simulated) does not support op kind '${op.kind}' — it is not an advertised capability`);
    }
  }
  // dataforseo — the REAL published USD table, so simulated and live price identically (the §A6-A3
  // AC: this arithmetic equals DFS_RATES arithmetic for every op kind).
  //
  // SM-44(b): 'serp'/'ai_visibility' must read config.search.dataforseo.queue exactly like the LIVE
  // driver's own estimateCostUsd() does (dataforseo.ts) — the live queue is 3.3x the Standard rate
  // ($0.002 vs $0.0006). Pricing this unconditionally at Standard, as the sim used to, meant a
  // live-queue demo UNDER-priced by 3.3x: the stop-loss and SM-29's projected cost would both lie
  // about a config an operator explicitly flipped, defeating the whole point of §A4.5 ("simulated
  // and live price identically").
  const dfsPerTask = config.search.dataforseo.queue === "live" ? DFS_RATES.serpLivePerTask : DFS_RATES.serpStandardPerTask;
  switch (op.kind) {
    case "serp": return dfsPerTask * items;
    case "volume": return DFS_RATES.keywordsDataPerTask + DFS_RATES.keywordsDataPerKeyword * items;
    case "suggestions": return DFS_RATES.labsPerTask + DFS_RATES.labsPerItem * items;
    case "backlinks": return DFS_RATES.backlinksSummary * items;
    case "ai_visibility": return dfsPerTask * items;
  }
}

// ── the driver ──────────────────────────────────────────────────────────────────────────────────────
/** One simulated vendor driver. Behind the UNCHANGED SearchDataProvider interface, so it flows
 *  through the real dispatchProviderOp: cache, single-flight, all five fail-closed gates, and ledger
 *  rows with synthetic dollars. `simulated = true` is what dispatch stamps into the provenance. */
export class SimulatedSearchProvider implements SearchDataProvider {
  readonly key: ProviderKey;
  readonly capabilities: Set<Capability>;
  /** Provenance marker read structurally by isSimulatedProvider() (see its doc comment). */
  readonly simulated = true as const;
  readonly label: string;

  /** Mirrors MockSearchProvider so the money-safety proofs (single-flight, "dispatched exactly
   *  once") can be re-run against a simulated driver without a second harness. */
  dispatchCount = 0;
  delayMs = 0;

  constructor(private readonly profile: VendorProfile) {
    this.key = profile.key;
    this.label = profile.label;
    this.capabilities = new Set(profile.capabilities);
  }

  private async tick(): Promise<void> {
    this.dispatchCount += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  /** A capability the real vendor does not sell must FAIL here, loudly. dispatch.ts already refuses
   *  such an op at the capability gate (NoCapableProviderError), so reaching this line means a
   *  routing bug — and returning plausible data would hide it. */
  private refuse(cap: Capability): never {
    throw new Error(`${this.label} does not offer '${cap}' — simulated drivers advertise only their real vendor's capabilities (SM-33)`);
  }

  // ── SERP ────────────────────────────────────────────────────────────────────────────────────────
  async postSerpTasks(reqs: SerpRequest[]): Promise<TaskRef[]> {
    if (!this.capabilities.has("serp")) this.refuse("serp");
    await this.tick();
    // Task ids are deterministic too: a re-run of the same demo produces the same ids, so a
    // screenshot or a fixture stays valid.
    return reqs.map((r) => ({
      id: `${this.key}-sim-${hash32(`${this.key}|${normalize(r.keyword)}|${r.locale ?? "_"}`).toString(16)}`,
      keyword: r.keyword,
    }));
  }

  async fetchSerpResults(refs: TaskRef[]): Promise<SerpResult[]> {
    if (!this.capabilities.has("serp")) this.refuse("serp");
    return refs.map((ref) => this.serpFor(ref.keyword));
  }

  private serpFor(keyword: string): SerpResult {
    const k = normalize(keyword);
    const intent = classifyIntent(k);
    const p = this.profile;

    // Candidate pool: an intent-weighted slice of the well-known sites plus keyword-derived brand
    // domains, so a SERP for "best crm software" is full of review sites and one for "buy running
    // shoes" is full of retailers.
    const s = slugify(k).slice(0, 28);
    const brandish = [`${s}.example.com`, `www.${s}-hq.example.net`, `blog.${s}.example.org`, `${s}-reviews.example.io`];
    const themed = intent === "transactional" ? COMMERCE_DOMAINS : intent === "commercial" ? B2B_DOMAINS : EVERGREEN_DOMAINS;
    // SM-48 (tracker §6s): a PLATFORM-LEVEL, tenant-agnostic portfolio-domain list (config, simulate
    // mode only — see config.ts's doc comment on config.search.simulation.portfolioDomains). Folded
    // straight into the SAME candidate pool every other domain competes in below, so it is scored by
    // the identical shared+vendor formula rather than any bespoke "always rank this one" rule — the
    // pool stays byte-identical for every tenant/caller (no cross-tenant leak into search_data_cache,
    // D-4), and unset (the default, empty array) leaves this line a no-op spread of nothing.
    //
    // QA follow-up (⚡ gate, 2026-07-30): config.ts only trims/lower-cases the raw env value — it does
    // NOT strip a scheme, a trailing slash, or a leading "www.". rank.ts's own findPropertyPosition
    // matches via `hostnameOf(item.url)` against `normalizeDomain(propertyDomain)`, which DOES strip
    // all three. Left alone, an operator who pastes a URL (`https://balibeach.test`) instead of a bare
    // domain into SEARCH_SIMULATION_PORTFOLIO_DOMAINS gets a candidate whose serpUrl() becomes
    // `https://https://balibeach.test/...` — a hostname of literally "https" once parsed — so the
    // configured property silently becomes an unrankable phantom slot with no error anywhere. This is
    // exactly the two-independent-normalizations-of-the-same-string class this module's design notes
    // (§4i) keep flagging, so the same stripping is applied here rather than trusting config.ts's raw
    // string (config.ts is out of scope for this gate — see tracker's fix-policy note).
    const normalizedPortfolioDomains = config.search.simulation.portfolioDomains
      .map((d) => d.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    const candidates = [...new Set([
      ...themed, ...EVERGREEN_DOMAINS.slice(0, 4), ...brandish, ...normalizedPortfolioDomains,
    ])];

    const items = candidates
      .map((domain) => ({
        domain,
        // The SHARED component dominates (0.82) so all three vendors mostly agree on who ranks;
        // the vendor component reorders the middle of the page, which is what really happens.
        score: (1 - p.serpDivergence) * unit("serp", k, domain) + p.serpDivergence * unit("serpv", p.key, k, domain),
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, p.serpRows)
      .map((c, i) => ({
        position: i + 1,
        url: serpUrl(k, c.domain),
        title: serpTitle(k, c.domain),
      }));

    return { keyword: k, items, serpFeatures: serpFeatures(k, intent, p.reportedSerpFeatures) };
  }

  // ── keyword metrics ─────────────────────────────────────────────────────────────────────────────
  async getKeywordMetrics(kws: KeywordQuery[]): Promise<KeywordMetrics[]> {
    if (!this.capabilities.has("volume")) this.refuse("volume");
    await this.tick();
    return kws.map((q) => this.metricsFor(q));
  }

  private metricsFor(q: KeywordQuery): KeywordMetrics {
    const p = this.profile;
    const m = simulateMarket(q.keyword, q.locale, q.locationCode);
    const market = `${q.locale ?? "_"}|${q.locationCode ?? "_"}`;

    const volume = reportedVolume(m.volume * p.volumeBias * jitter(p.volumeJitter, "vvol", p.key, m.keyword, market));
    const difficulty = Number(
      clamp(m.difficulty * p.difficultyBias * jitter(p.difficultyJitter, "vkd", p.key, m.keyword, market), 1, 100)
        .toFixed(p.difficultyDecimals),
    );
    const cpcUsd = Number(
      (m.cpcUsd * p.cpcBias * jitter(p.cpcJitter, "vcpc", p.key, m.keyword, market)).toFixed(2),
    );

    return {
      keyword: q.keyword,
      volume,
      cpcUsd: Math.max(0.01, cpcUsd),
      ...(this.capabilities.has("difficulty") ? { difficulty } : {}),
      // ONLY the vendor that actually sells a suggestions product returns them. A consumer that
      // assumes this array is always present is a bug this asymmetry surfaces in dev.
      ...(this.capabilities.has("suggestions")
        ? { suggestions: simulateSuggestions(m.keyword, 5 + Math.floor(unit("suggn", m.keyword) * 4)) }
        : {}),
    };
  }

  // ── backlinks ───────────────────────────────────────────────────────────────────────────────────
  async getBacklinkSummary(target: string): Promise<BacklinkSummary> {
    if (!this.capabilities.has("backlinks")) this.refuse("backlinks");
    await this.tick();
    const p = this.profile;
    const b = simulateBacklinks(target);
    const bias = p.backlinkBias * jitter(0.12, "vbl", p.key, b.domain);
    return {
      target,
      backlinks: Math.max(1, Math.round(b.backlinks * bias)),
      // Referring domains diverge LESS than raw link counts between vendors (a domain is either in
      // the index or not; a link is a crawl-depth question) — so a smaller bias exponent.
      refDomains: Math.max(1, Math.round(b.refDomains * Math.pow(bias, 0.55))),
      authorityScore: clamp(Math.round(b.authorityScore * jitter(0.06, "vas", p.key, b.domain)), 1, 100),
    };
  }

  // ── AI visibility (GEO) ─────────────────────────────────────────────────────────────────────────
  async getAiVisibility(q: AiVisibilityQuery): Promise<AiVisibilityResult[]> {
    if (!this.capabilities.has("ai_visibility")) this.refuse("ai_visibility");
    await this.tick();
    // No engine named => one row per engine the schema accepts, which is what the GEO console's
    // per-engine comparison needs. An explicitly named engine is echoed back as asked.
    const engines = q.engine ? [q.engine] : [...AI_ENGINES];
    return engines.map((engine) => simulateAiVisibility(q.query, engine));
  }

  // ── cost ────────────────────────────────────────────────────────────────────────────────────────
  /** Pure + synchronous (the stop-loss and the projection endpoint both call it before dispatch). */
  estimateCostUsd(op: ProviderOp): number {
    return estimateFor(this.key, op);
  }
}

/** THE bootstrap entry point (SM-34's main.ts registers these when providerMode === 'simulate').
 *  One driver per vendor key, each advertising only its real vendor's capabilities. */
export function createSimulationProviders(): SearchDataProvider[] {
  return VENDOR_PROFILES.map((p) => new SimulatedSearchProvider(p));
}

/** Test/inspection seam: the vendor keys this tier registers, in registration order. */
export const SIMULATED_PROVIDER_KEYS = VENDOR_PROFILES.map((p) => String(p.key));

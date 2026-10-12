// M5-W3 — the editorial content-rule configuration. DEFAULT_CONTENT_RULES holds gaiada.com's documented
// values (gaiada-web-revamp/docs/CONTENT_RULES.md + BUILD_SPEC.md). They are DATA, not code paths: every
// rule reads its number or list from a ContentRulesConfig, so a client tenant is served by passing its own
// config, never by editing a rule.
//
// Where the config comes from (M5-W3c, vocabulary 1.3.0): the collection's composition may declare
// `lint.content`; `resolveContentRulesFromComposition` maps it onto this config. ABSENT member (or an
// absent key inside it) = DEFAULT_CONTENT_RULES, so a site that declares nothing is served byte-identically
// to before. Save, item.get and the sign-off snapshot all call that one function, so they cannot disagree.
// `resolveContentRules` is the one place a partial, untrusted FLAT override is sanitised.
import { validateContentLintSettings } from "../../../delivery/vocabulary/composition";

export interface ContentRulesConfig {
  /** Master switch: false = no `content` member is added to the lint report. */
  enabled: boolean;
  /** A body of at least this many words is "long-form" and gets the structural checks. */
  longFormMinWords: number;
  /** Meta title: at most this many characters (BUILD_SPEC: <= 60). */
  metaTitleMax: number;
  /** Meta description: between min and max characters (BUILD_SPEC <= 155; the copy audit's floor is 120). */
  metaDescriptionMin: number;
  metaDescriptionMax: number;
  /** The first paragraph after the H1 is a complete answer of this many words (CONTENT_RULES "Answer-first"). */
  answerFirstMinWords: number;
  answerFirstMaxWords: number;
  /** At least this share of h2/h3 headings is phrased as a question. */
  questionHeadingShare: number;
  /** Internal links wanted in a long-form body. The site audit counts a whole rendered page, so this is info only. */
  minInternalLinks: number;
  /** Heading starters (lowercase, first word) that make a heading a question, besides a trailing "?". */
  questionStarters: string[];
  /** Field holding the page H1 when the H1 is not a `# ` heading inside the body. */
  h1Field: string;
  /** Field holding the one primary keyword; absent or empty = the keyword check is skipped. */
  primaryKeywordField: string;
  /** Top-level text fields (string or string[]) that hold image alt texts. */
  altFields: string[];
  /** Locale families (primary subtag) -> the locale families that must exist as a twin in the localization group. */
  twin: Record<string, string[]>;
  /** Banned phrases per language (primary subtag), matched case-insensitively as whole words/phrases. */
  bannedPhrases: Record<string, string[]>;
  /** Paragraphs longer than this many words are "long" for the AEO short-paragraph factor. */
  shortParagraphMaxWords: number;
  /** Rule ids (see CONTENT_LINT_RULE_IDS; `aeo` is the score) the composition switched off. Empty by default. */
  disabledRules: string[];
}

export const DEFAULT_CONTENT_RULES: ContentRulesConfig = {
  enabled: true,
  longFormMinWords: 300,
  metaTitleMax: 60,
  metaDescriptionMin: 120,
  metaDescriptionMax: 155,
  answerFirstMinWords: 40,
  answerFirstMaxWords: 60,
  questionHeadingShare: 0.3,
  minInternalLinks: 20,
  questionStarters: [
    "what", "how", "why", "when", "where", "who", "which", "can", "does", "do", "is", "are", "should", "will",
    "apa", "bagaimana", "mengapa", "kenapa", "kapan", "dimana", "siapa", "berapa", "apakah", "bisakah",
  ],
  h1Field: "h1",
  primaryKeywordField: "primary_keyword",
  altFields: ["image_alt_texts"],
  twin: { en: ["id"], id: ["en"] },
  bannedPhrases: {
    en: [
      "cutting-edge", "leverage", "leverages", "leveraged", "leveraging", "seamless", "seamlessly", "robust",
      "holistic", "unlock", "elevate", "empower", "game-changer", "world-class", "delve",
      "in today's digital age", "we pride ourselves",
    ],
  },
  shortParagraphMaxWords: 80,
  disabledRules: [],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 120) ? (v as string[]) : fallback;
const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
const locMap = (v: unknown, fallback: Record<string, string[]>): Record<string, string[]> => {
  if (!isRecord(v)) return fallback;
  const out: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(v)) out[k.toLowerCase()] = strList(list, []);
  return out;
};

/** Sanitise a partial override over the defaults. A bad member falls back to its default; nothing throws. */
export function resolveContentRules(override?: unknown): ContentRulesConfig {
  const d = DEFAULT_CONTENT_RULES;
  if (!isRecord(override)) return d;
  const min = num(override.metaDescriptionMin, d.metaDescriptionMin, 0, 1000);
  const max = num(override.metaDescriptionMax, d.metaDescriptionMax, 0, 1000);
  const aMin = num(override.answerFirstMinWords, d.answerFirstMinWords, 0, 1000);
  const aMax = num(override.answerFirstMaxWords, d.answerFirstMaxWords, 0, 1000);
  return {
    enabled: typeof override.enabled === "boolean" ? override.enabled : d.enabled,
    longFormMinWords: num(override.longFormMinWords, d.longFormMinWords, 1, 100000),
    metaTitleMax: num(override.metaTitleMax, d.metaTitleMax, 1, 1000),
    metaDescriptionMin: min <= max ? min : d.metaDescriptionMin,
    metaDescriptionMax: min <= max ? max : d.metaDescriptionMax,
    answerFirstMinWords: aMin <= aMax ? aMin : d.answerFirstMinWords,
    answerFirstMaxWords: aMin <= aMax ? aMax : d.answerFirstMaxWords,
    questionHeadingShare: num(override.questionHeadingShare, d.questionHeadingShare, 0, 1),
    minInternalLinks: num(override.minInternalLinks, d.minInternalLinks, 0, 10000),
    questionStarters: strList(override.questionStarters, d.questionStarters).map((s) => s.toLowerCase()),
    h1Field: typeof override.h1Field === "string" && override.h1Field ? override.h1Field : d.h1Field,
    primaryKeywordField: typeof override.primaryKeywordField === "string" && override.primaryKeywordField ? override.primaryKeywordField : d.primaryKeywordField,
    altFields: strList(override.altFields, d.altFields),
    twin: locMap(override.twin, d.twin),
    bannedPhrases: locMap(override.bannedPhrases, d.bannedPhrases),
    shortParagraphMaxWords: num(override.shortParagraphMaxWords, d.shortParagraphMaxWords, 1, 10000),
    disabledRules: strList(override.disabledRules, d.disabledRules),
  };
}

type Dict = Record<string, unknown>;
const lowerKeys = (m: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(m as Dict)) out[k.toLowerCase()] = (v as string[]).slice();
  return out;
};
const pick = <T>(v: unknown, fallback: T): T => (v === undefined ? fallback : (v as T));

/**
 * Map a collection composition's `lint.content` (vocabulary 1.3.0) onto a ContentRulesConfig.
 *  - absent member  -> DEFAULT_CONTENT_RULES itself (the same object: nothing is recomputed, nothing differs);
 *  - absent key     -> that key's default;
 *  - an invalid stored value (the write plane refuses it, so only a hand-edited row can hold one) -> the
 *    defaults, wholesale. It never throws, and never half-applies a setting it could not validate.
 * A `twin` / `phrases` map REPLACES the default map (a site that sets `phrases: { id: [...] }` has no English list).
 */
export function resolveContentRulesFromComposition(composition: { lint?: { content?: unknown } } | null | undefined): ContentRulesConfig {
  const raw = composition?.lint?.content;
  if (raw === undefined) return DEFAULT_CONTENT_RULES;
  try {
    if (validateContentLintSettings("lint.content", raw).length > 0) return DEFAULT_CONTENT_RULES;
  } catch {
    return DEFAULT_CONTENT_RULES;
  }
  const c = raw as Dict;
  const rules = (c.rules ?? {}) as Record<string, Dict>;
  const d = DEFAULT_CONTENT_RULES;
  const meta = rules.meta ?? {};
  const af = rules["answer-first"] ?? {};
  const qh = rules["question-headings"] ?? {};
  return {
    enabled: pick(c.enabled, d.enabled),
    longFormMinWords: pick(c.longFormMinWords, d.longFormMinWords),
    metaTitleMax: pick(meta.titleMax, d.metaTitleMax),
    metaDescriptionMin: pick(meta.descriptionMin, d.metaDescriptionMin),
    metaDescriptionMax: pick(meta.descriptionMax, d.metaDescriptionMax),
    answerFirstMinWords: pick(af.minWords, d.answerFirstMinWords),
    answerFirstMaxWords: pick(af.maxWords, d.answerFirstMaxWords),
    questionHeadingShare: pick(qh.minShare, d.questionHeadingShare),
    minInternalLinks: pick(rules["internal-links"]?.min, d.minInternalLinks),
    questionStarters: qh.starters === undefined ? d.questionStarters : (qh.starters as string[]).map((s) => s.toLowerCase()),
    h1Field: pick(c.h1Field, d.h1Field),
    primaryKeywordField: pick(c.primaryKeywordField, d.primaryKeywordField),
    altFields: c.altFields === undefined ? d.altFields : (c.altFields as string[]).slice(),
    twin: rules["id-twin"]?.twin === undefined ? d.twin : lowerKeys(rules["id-twin"].twin),
    bannedPhrases: rules["banned-language"]?.phrases === undefined ? d.bannedPhrases : lowerKeys(rules["banned-language"].phrases),
    shortParagraphMaxWords: pick(rules.aeo?.shortParagraphMaxWords, d.shortParagraphMaxWords),
    disabledRules: Object.entries(rules).filter(([, r]) => r.enabled === false).map(([id]) => id).sort(),
  };
}

// SCP-1a — the brand book's types, parsing and client-side validation (BFF §63.1 `social_brand_profiles`, §63.4). No server-only import, so
// the reusable `BrandBookForm` (and SCP-1k's Client profile tab) may import the values.
//
// The brand book is the client's, read and written through `GET`/`PATCH brand-profiles/:clientId`. Reading needs `social_engagement` · `read` (the
// copywriter and designer roles hold it); writing needs `update`. THE SERVER DECIDES: `validateBrandBook` mirrors its rules (BFF §63.1) so the form
// can say what is wrong before it sends, and the server's own 400 `{field}` still comes back and is worded by `brandBookRefusalText`.
import { ALLOCATION_NETWORKS } from "./socialAllocation";

export const BRAND_LIMITS = {
  toneSummary: 200,
  contentPillars: { max: 20, each: 60 },
  mustHaveNotes: { max: 20, each: 300 },
  brandRules: { max: 30, each: 300 },
  hashtagSets: { max: 10, name: 60, tags: 30 },
  channels: { max: 30, handle: 100, url: 500 },
  keyDates: { max: 100, label: 120 },
  links: { max: 30, label: 100, url: 500 },
} as const;

export interface HashtagSet { name: string; tags: string[] }
export interface BrandChannel { network: string; handle: string; url?: string }
export interface KeyDate { date: string; label: string }
export interface BrandLink { label: string; url: string }

/** The brand book, as the form holds it and the server answers it. */
export interface BrandBook {
  toneSummary: string;
  contentPillars: string[];
  mustHaveNotes: string[];
  brandRules: string[];
  hashtagSets: HashtagSet[];
  channels: BrandChannel[];
  keyDates: KeyDate[];
  links: BrandLink[];
}

export const EMPTY_BRAND_BOOK: BrandBook = {
  toneSummary: "", contentPillars: [], mustHaveNotes: [], brandRules: [], hashtagSets: [], channels: [], keyDates: [], links: [],
};

export const BRAND_FIELD_LABEL: Readonly<Record<keyof BrandBook, string>> = {
  toneSummary: "Tone in one line", contentPillars: "Content pillars", mustHaveNotes: "Must-have notes", brandRules: "Brand rules",
  hashtagSets: "Hashtag sets", channels: "Channels", keyDates: "Key dates", links: "Links",
};

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The brand book out of a `GET brand-profiles/:clientId` answer. Reads the new fields (`toneSummary`, `contentPillars`, …) and falls back to the
 * keys inside `tone` and `hashtagStrategy` when an older server did not add them. Throws on a body that is not an object.
 */
export function asBrandBook(raw: unknown): BrandBook {
  if (!isObj(raw)) throw new Error("brand profile: not an object");
  const tone = isObj(raw.tone) ? raw.tone : {};
  const strategy = isObj(raw.hashtagStrategy) ? raw.hashtagStrategy : {};
  const setsRaw = Array.isArray(raw.hashtagSets) ? raw.hashtagSets : Array.isArray(strategy.sets) ? strategy.sets : [];
  return {
    toneSummary: typeof raw.toneSummary === "string" ? raw.toneSummary : typeof tone.summary === "string" ? tone.summary : "",
    contentPillars: strings(raw.contentPillars),
    mustHaveNotes: strings(raw.mustHaveNotes),
    brandRules: strings(raw.brandRules),
    hashtagSets: setsRaw.filter(isObj).map((s) => ({ name: typeof s.name === "string" ? s.name : "", tags: strings(s.tags) })),
    channels: (Array.isArray(raw.channels) ? raw.channels : []).filter(isObj).map((c) => ({
      network: typeof c.network === "string" ? c.network : "", handle: typeof c.handle === "string" ? c.handle : "",
      ...(typeof c.url === "string" && c.url ? { url: c.url } : {}),
    })),
    keyDates: (Array.isArray(raw.keyDates) ? raw.keyDates : []).filter(isObj).map((d) => ({ date: typeof d.date === "string" ? d.date : "", label: typeof d.label === "string" ? d.label : "" })),
    links: (Array.isArray(raw.links) ? raw.links : []).filter(isObj).map((l) => ({ label: typeof l.label === "string" ? l.label : "", url: typeof l.url === "string" ? l.url : "" })),
  };
}

// ── Validation (a mirror of the server's rules) ─────────────────────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `MM-DD` (a real day of a leap year) or a real `YYYY-MM-DD`. */
export function isKeyDate(s: string): boolean {
  let m = /^(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= DAYS_IN_MONTH[mo - 1];
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type BrandBookCheck = { ok: true; book: BrandBook } | { ok: false; field: keyof BrandBook; message: string };

const textList = (list: string[], lim: { max: number; each: number }, label: string, field: keyof BrandBook): BrandBookCheck | null => {
  if (list.length > lim.max) return { ok: false, field, message: `${label}: at most ${lim.max}.` };
  if (list.some((x) => x.length > lim.each)) return { ok: false, field, message: `${label}: each line is at most ${lim.each} characters.` };
  return null;
};

/** One tag per word, no '#', trimmed: how a typed tag line becomes the stored list. */
export function parseTags(text: string): string[] {
  return text.split(/[\s,]+/).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
}

/** One entry per non-empty line, trimmed. */
export function parseLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Trims and checks a whole brand book against BFF §63.1's rules. The first problem is named by its field; the server re-checks everything. */
export function validateBrandBook(input: BrandBook): BrandBookCheck {
  const b: BrandBook = {
    toneSummary: input.toneSummary.trim(),
    contentPillars: input.contentPillars.map((x) => x.trim()).filter(Boolean),
    mustHaveNotes: input.mustHaveNotes.map((x) => x.trim()).filter(Boolean),
    brandRules: input.brandRules.map((x) => x.trim()).filter(Boolean),
    hashtagSets: input.hashtagSets.map((s) => ({ name: s.name.trim(), tags: s.tags.map((t) => t.replace(/^#+/, "").trim()).filter(Boolean) })),
    channels: input.channels.map((c) => ({ network: c.network, handle: c.handle.trim(), ...(c.url && c.url.trim() ? { url: c.url.trim() } : {}) })),
    keyDates: input.keyDates.map((d) => ({ date: d.date.trim(), label: d.label.trim() })),
    links: input.links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
  };
  if (b.toneSummary.length > BRAND_LIMITS.toneSummary) return { ok: false, field: "toneSummary", message: `Tone in one line: at most ${BRAND_LIMITS.toneSummary} characters.` };
  const lists = textList(b.contentPillars, BRAND_LIMITS.contentPillars, "Content pillars", "contentPillars")
    ?? textList(b.mustHaveNotes, BRAND_LIMITS.mustHaveNotes, "Must-have notes", "mustHaveNotes")
    ?? textList(b.brandRules, BRAND_LIMITS.brandRules, "Brand rules", "brandRules");
  if (lists) return lists;

  const hs = BRAND_LIMITS.hashtagSets;
  if (b.hashtagSets.length > hs.max) return { ok: false, field: "hashtagSets", message: `Hashtag sets: at most ${hs.max}.` };
  for (const s of b.hashtagSets) {
    if (!s.name || s.name.length > hs.name) return { ok: false, field: "hashtagSets", message: `Every hashtag set needs a name of at most ${hs.name} characters.` };
    if (s.tags.length > hs.tags) return { ok: false, field: "hashtagSets", message: `A hashtag set holds at most ${hs.tags} tags.` };
  }

  const ch = BRAND_LIMITS.channels;
  if (b.channels.length > ch.max) return { ok: false, field: "channels", message: `Channels: at most ${ch.max}.` };
  for (const c of b.channels) {
    if (!(ALLOCATION_NETWORKS as readonly string[]).includes(c.network)) return { ok: false, field: "channels", message: "Choose a network for every channel." };
    if (!c.handle || c.handle.length > ch.handle) return { ok: false, field: "channels", message: `Every channel needs a handle of at most ${ch.handle} characters.` };
    if (c.url !== undefined && (c.url.length > ch.url || !isHttpUrl(c.url))) return { ok: false, field: "channels", message: "A channel's link must start with http:// or https://." };
  }

  const kd = BRAND_LIMITS.keyDates;
  if (b.keyDates.length > kd.max) return { ok: false, field: "keyDates", message: `Key dates: at most ${kd.max}.` };
  for (const d of b.keyDates) {
    if (!isKeyDate(d.date)) return { ok: false, field: "keyDates", message: "A key date is a real day as MM-DD (every year) or YYYY-MM-DD." };
    if (!d.label || d.label.length > kd.label) return { ok: false, field: "keyDates", message: `Every key date needs a label of at most ${kd.label} characters.` };
  }

  const lk = BRAND_LIMITS.links;
  if (b.links.length > lk.max) return { ok: false, field: "links", message: `Links: at most ${lk.max}.` };
  for (const l of b.links) {
    if (!l.label || l.label.length > lk.label) return { ok: false, field: "links", message: `Every link needs a label of at most ${lk.label} characters.` };
    if (l.url.length > lk.url || !isHttpUrl(l.url)) return { ok: false, field: "links", message: "A link must start with http:// or https://." };
  }
  return { ok: true, book: b };
}

/** The sentence for a refusal code of the brand-book write. */
export function brandBookRefusalText(code: string, field?: string): string {
  if (code === "invalid_field") {
    const label = field && field in BRAND_FIELD_LABEL ? BRAND_FIELD_LABEL[field as keyof BrandBook] : field;
    return label ? `${label} is not valid. Check its limits and try again.` : "A value is not valid.";
  }
  if (code === "no_fields") return "Nothing to save.";
  if (/not authorized/i.test(code)) return "You can read the brand book but not change it.";
  return code;
}
